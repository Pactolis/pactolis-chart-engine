import type { ChartPanelState, LinkGroupColor } from "../../core/chartPanelState.js";
import { ChartChange } from "../../core/render/scene/chartScene.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { ChartSession } from "./ChartSession.js";
import type { View } from "../../core/engine/view.js";
import type { TimeScaleViewportController } from "../controllers/timeScaleViewportController.js";
import type { ReplaySnapshot } from "../replay/replayController.js";

export interface ChartSyncControllerHost {
  readonly pipeline: ChartDataPipeline;
  readonly session: ChartSession;
  readonly view: View;
  readonly timeViewport: TimeScaleViewportController;
  isDisposed(): boolean;
  getState(): ChartPanelState;
  updateState(next: ChartPanelState): void;
  persistState(next: ChartPanelState): void;
  autoFit(): void;
  applyExternalReplay(snapshot: ReplaySnapshot | null): void;
  subscribeReplayState(cb: (snapshot: ReplaySnapshot | null) => void): () => void;
  fillVisibleFootprintRange?(range: { from: number; to: number }): void;
}

type VisibleRange = { from: number; to: number };
type CrosshairEvent = { time: number | null; price: number | null };

/** Owns link-group reentrancy, ghost crosshair state and sync listener fan-out. */
export class ChartSyncController {
  private applyingExternal = false;
  private syncCrosshairTime: number | null = null;
  private syncCrosshairDisplayTime: number | null = null;
  private readonly rangeListeners = new Set<(range: VisibleRange) => void>();
  private readonly crosshairListeners = new Set<(event: CrosshairEvent) => void>();
  private readonly timeframeListeners = new Set<(timeframe: string) => void>();
  private readonly marketListeners = new Set<(market: string) => void>();
  private readonly linkGroupListeners = new Set<(previous: LinkGroupColor | undefined) => void>();

  constructor(private readonly host: ChartSyncControllerHost) {}

  get isApplyingExternal(): boolean { return this.applyingExternal; }
  /** Logical-time projection consumed by the overlay's contiguous index arithmetic. */
  get ghostCrosshairTime(): number | null { return this.syncCrosshairDisplayTime; }
  get ghostCrosshairSourceTime(): number | null { return this.syncCrosshairTime; }

  getVisibleTimeRange(): VisibleRange | null {
    const series = this.host.pipeline.series;
    const view = this.host.view;
    if (series.length === 0 || view.area.width <= 1) return null;
    const from = series.timeOfIndex(view.indexOfX(view.area.left));
    const to = series.timeOfIndex(view.indexOfX(view.area.left + view.area.width));
    if (from == null || to == null) return null;
    return { from, to };
  }

  setVisibleTimeRange(range: VisibleRange): void {
    if (this.host.isDisposed()) return;
    const series = this.host.pipeline.series;
    if (series.length === 0) return;
    const fromIdx = series.indexOfTime(range.from);
    const toIdx = series.indexOfTime(range.to);
    if (toIdx <= fromIdx) return;
    this.applyingExternal = true;
    try {
      this.host.view.setVisibleIndexRange(fromIdx, toIdx);
      this.host.timeViewport.markUserViewportChange(series.length);
      this.host.autoFit();
      this.host.session.invalidate(ChartChange.Viewport);
    } finally {
      this.applyingExternal = false;
    }
  }

  subscribeVisibleRange(cb: (range: VisibleRange) => void): () => void {
    this.rangeListeners.add(cb);
    return () => this.rangeListeners.delete(cb);
  }

  subscribeCrosshair(cb: (event: CrosshairEvent) => void): () => void {
    this.crosshairListeners.add(cb);
    return () => this.crosshairListeners.delete(cb);
  }

  subscribeTimeframe(cb: (timeframe: string) => void): () => void {
    this.timeframeListeners.add(cb);
    return () => this.timeframeListeners.delete(cb);
  }

  subscribeMarket(cb: (market: string) => void): () => void {
    this.marketListeners.add(cb);
    return () => this.marketListeners.delete(cb);
  }

  emitStateChanges(previous: ChartPanelState, next: ChartPanelState): void {
    if (this.applyingExternal) return;
    if (next.timeframe !== previous.timeframe) {
      for (const listener of this.timeframeListeners) listener(next.timeframe);
    }
    if (next.market !== previous.market) {
      for (const listener of this.marketListeners) listener(next.market);
    }
  }

  emitVisibleRange(): void {
    if (this.applyingExternal) return;
    const range = this.getVisibleTimeRange();
    if (!range) return;
    for (const listener of this.rangeListeners) listener(range);
    this.host.fillVisibleFootprintRange?.(range);
  }

  notifyCrosshair(event: CrosshairEvent): void {
    for (const listener of this.crosshairListeners) listener(event);
  }

  showCrosshair(time: number): void {
    if (this.host.isDisposed()) return;
    this.syncCrosshairTime = time;
    const series = this.host.pipeline.series;
    const firstTime = series.at(0)?.startTime;
    this.syncCrosshairDisplayTime = firstTime === undefined
      ? time
      : firstTime + series.indexOfTime(time) * series.config.intervalMs;
    this.host.session.invalidate(ChartChange.Interaction);
  }

  hideCrosshair(): void {
    if (this.syncCrosshairTime == null && this.syncCrosshairDisplayTime == null) return;
    this.syncCrosshairTime = null;
    this.syncCrosshairDisplayTime = null;
    this.host.session.invalidate(ChartChange.Interaction);
  }

  applyExternalTimeframe(timeframe: string): void {
    if (this.host.isDisposed()) return;
    const state = this.host.getState();
    if (state.timeframe === timeframe) return;
    this.applyingExternal = true;
    try {
      this.host.updateState({ ...state, timeframe });
    } finally {
      this.applyingExternal = false;
    }
  }

  applyExternalMarket(market: string): void {
    if (this.host.isDisposed()) return;
    const state = this.host.getState();
    if (state.market === market) return;
    this.applyingExternal = true;
    try {
      this.host.updateState({ ...state, market });
    } finally {
      this.applyingExternal = false;
    }
  }

  setLinkGroup(color: LinkGroupColor | null): void {
    if (this.host.isDisposed()) return;
    const state = this.host.getState();
    const group = color ?? undefined;
    if (state.linkGroup === group) return;
    const next = { ...state, linkGroup: group } as ChartPanelState;
    this.hideCrosshair();
    this.host.persistState(next);
    this.host.session.invalidate();
    for (const listener of this.linkGroupListeners) listener(state.linkGroup);
  }

  /** Called with the group the chart left, after its state names the new one. */
  subscribeLinkGroup(cb: (previous: LinkGroupColor | undefined) => void): () => void {
    this.linkGroupListeners.add(cb);
    return () => this.linkGroupListeners.delete(cb);
  }

  subscribeReplay(cb: (snapshot: ReplaySnapshot | null) => void): () => void {
    return this.host.subscribeReplayState(cb);
  }

  applyReplay(snapshot: ReplaySnapshot | null): void {
    this.host.applyExternalReplay(snapshot);
  }

  dispose(): void {
    this.rangeListeners.clear();
    this.crosshairListeners.clear();
    this.timeframeListeners.clear();
    this.marketListeners.clear();
    this.linkGroupListeners.clear();
  }
}
