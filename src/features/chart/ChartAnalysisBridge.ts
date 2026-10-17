import type { ChartAnalysisChange, ChartAnalysisServices } from "./ChartServicePorts.js";
import type { ChartSession } from "./ChartSession.js";
import { ChartSurfaceDirty } from "../../core/render/scene/chartScene.js";
import { recordPerformanceDuration } from "../../core/performanceTelemetry.js";

export interface ChartAnalysisBridgeHost {
  readonly svc: ChartAnalysisServices;
  readonly session: ChartSession;
  isDisposed(): boolean;
  getMarket(): string;
  updateHook(): void;
  noteAnalysisRevision(): void;
  noteAnalysisPaint(market: string, revision: number): void;
}

/**
 * Owns the analysis-change -> annotation-invalidation -> painted-revision handshake.
 * The bridge deliberately does not know about capture semantics; it only reports the
 * canonical market/revision that actually reached an annotation paint.
 */
export class ChartAnalysisBridge {
  private pendingRevision = 0;
  private pendingMarket = "";
  private readonly pendingPaints: number[] = [];
  private unsubscribeAnalysis: () => void = () => undefined;
  private unsubscribeRevision: () => void = () => undefined;

  constructor(private readonly host: ChartAnalysisBridgeHost) {
    this.resetMarket(host.getMarket());
    this.unsubscribeAnalysis = host.svc.subscribeAnalysis((change) => this.onAnalysisChange(change));
    this.unsubscribeRevision = host.svc.subscribeAnalysisRevision(() => {
      if (host.isDisposed()) return;
      host.noteAnalysisRevision();
      host.updateHook();
    });
  }

  resetMarket(market: string): void {
    this.pendingPaints.length = 0;
    const revision = this.host.svc.getAnalysisRevisionSnapshot(market);
    this.pendingRevision = revision.revision;
    this.pendingMarket = revision.market;
  }

  onAnnotationRendered(): void {
    if (this.host.isDisposed()) return;
    const paintedAt = performance.now();
    while (this.pendingPaints.length > 0) {
      const startedAt = this.pendingPaints.shift();
      if (startedAt !== undefined) {
        recordPerformanceDuration("analysis.change.annotation-paint.ms", Math.max(0, paintedAt - startedAt));
      }
    }
    if (this.pendingMarket !== this.host.getMarket()) return;
    this.host.noteAnalysisPaint(this.pendingMarket, this.pendingRevision);
  }

  dispose(): void {
    this.unsubscribeAnalysis();
    this.unsubscribeRevision();
    this.unsubscribeAnalysis = () => undefined;
    this.unsubscribeRevision = () => undefined;
    this.pendingPaints.length = 0;
  }

  private onAnalysisChange(change: ChartAnalysisChange): void {
    if (this.host.isDisposed()) return;
    const market = this.host.getMarket();
    if (change.kind === "automatic-data" && change.market !== market) return;

    const revision = this.host.svc.getAnalysisRevisionSnapshot(market);
    if (revision.market === market) {
      this.pendingRevision = revision.revision;
      this.pendingMarket = revision.market;
    }

    if (change.kind === "automatic-data") {
      if (this.pendingPaints.length >= 128) this.pendingPaints.shift();
      this.pendingPaints.push(performance.now());
      this.host.session.invalidateSurface(ChartSurfaceDirty.Annotation);
    } else {
      this.host.session.invalidate();
    }
    this.host.noteAnalysisRevision();
    this.host.updateHook();
  }
}
