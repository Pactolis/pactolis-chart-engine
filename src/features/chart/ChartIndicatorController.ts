import type { View } from "../../core/engine/view.js";
import type { ChartChange } from "../../core/render/scene/chartScene.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import type { AnalysisIndicatorSnapshot } from "../../core/analysisSnapshot.js";
import { IndicatorManager } from "../indicators/IndicatorManager.js";
import { getIndicatorDefinition } from "../indicators/registry.js";
import { drawMultiSeries, drawMultiSeriesInteraction } from "../indicators/builtins/taShared.js";
import type { IndicatorPaneHeadersModel } from "../indicators/indicatorPaneHeaders.js";
import type {
  IndicatorCrosshair,
  IndicatorDrawContext,
  IndicatorInstance,
  IndicatorPaneRect,
  IndicatorPaneRender,
  IndicatorPreparedData,
  IndicatorSettings,
} from "../indicators/types.js";

interface IndicatorControllerOptions {
  ownerDocument: Document;
  root: HTMLElement;
  initial: IndicatorInstance[] | undefined;
  onChange(instances: IndicatorInstance[]): void;
  onLayoutChange(): void;
  onInvalidate(changes?: ChartChange): void;
  getChartContext(): { market: string; timeframe: string; intervalMs: number };
  queuePriceLabel(price: number, text: string, color: string, priority?: number): void;
  headers: IndicatorPaneHeadersModel;
}

interface InteractionPreparedCacheEntry {
  definitionType: string;
  settings: IndicatorSettings;
  series: FootprintSeries;
  resetEpoch: number;
  revision: number;
  structureRevision: number;
  rangeFrom: number;
  rangeTo: number;
  market: string;
  timeframe: string;
  intervalMs: number;
  timeBucket: number;
  prepared: IndicatorPreparedData;
}

const LEGACY_CROSSHAIR_PANE_TYPES = new Set<string>();

/** Thin ownership boundary around IndicatorManager and its pane/layout lifecycle. */
export class ChartIndicatorController {
  private readonly manager: IndicatorManager;
  private readonly options: IndicatorControllerOptions;
  private readonly interactionPreparedCache = new Map<string, InteractionPreparedCacheEntry>();
  private latestView: View | null = null;

  private cachedPaneRendersRevision = -1;
  private cachedPaneRendersTimeframe = "";
  private cachedPaneRendersMaximized: boolean | null = null;
  private cachedBasePanesRef: readonly IndicatorPaneRender[] | null = null;
  private cachedControllerPaneRenders: IndicatorPaneRender[] = [];
  private cachedRequiresInteractionRedraw = false;

  clearInteractionCache(): void {
    this.interactionPreparedCache.clear();
    this.cachedPaneRendersRevision = -1;
    this.cachedPaneRendersTimeframe = "";
    this.cachedPaneRendersMaximized = null;
    this.cachedBasePanesRef = null;
    this.cachedControllerPaneRenders = [];
    this.cachedRequiresInteractionRedraw = false;
  }

  constructor(options: IndicatorControllerOptions) {
    this.options = options;
    this.manager = new IndicatorManager(options);
  }

  listInstances(): IndicatorInstance[] { return this.manager.listInstances(); }
  updateOwnerDocument(ownerDocument: Document): void { this.manager.updateOwnerDocument(ownerDocument); }
  getAnalysisSnapshots(series: FootprintSeries, closedRange: [number, number], maxSamples = 20): AnalysisIndicatorSnapshot[] {
    const chart = this.options.getChartContext();
    const closed = this.manager.getAnalysisSnapshots(series, chart, closedRange, maxSamples);
    const view = this.latestView;
    if (!view || !closed.some((item) => item.scope === "visible-range")) return closed;
    const from = Math.max(0, Math.floor(view.indexOfX(view.area.left)));
    const to = Math.min(closedRange[1], Math.ceil(view.indexOfX(view.area.left + view.area.width)) + 1);
    const visibleRange: [number, number] = [Math.min(from, to), Math.max(from, to)];
    const visible = this.manager.getAnalysisSnapshots(series, chart, visibleRange, maxSamples);
    return closed.map((item, index) => item.scope === "visible-range" ? visible[index] : item);
  }
  restore(instances: IndicatorInstance[] | undefined): void {
    this.clearInteractionCache();
    this.manager.restore(instances);
  }
  setVisible(id: string, visible: boolean): void { this.manager.setIndicatorVisible(id, visible); }
  remove(id: string): void {
    this.interactionPreparedCache.delete(id);
    this.clearInteractionCache();
    this.manager.deleteIndicator(id);
  }
  openSettings(id: string): void { this.manager.openIndicatorSettings(id); }
  togglePaneMaximizeAt(y: number): boolean { return this.manager.toggleMaximizedPaneAt(y); }
  isPaneMaximized(): boolean { return this.manager.isIndicatorPaneMaximized(); }
  isChartPaneMaximized(): boolean { return this.manager.isChartPaneMaximized(); }
  toggleChartPaneMaximized(): void { this.manager.toggleChartPaneMaximized(); }
  hasSeparatePanes(): boolean { return this.manager.hasSeparatePanes(); }
  getPaneRenders(): IndicatorPaneRender[] {
    const basePanes = this.manager.getPaneRenders();
    const revision = this.manager.getRenderRevision();
    const timeframe = this.options.getChartContext().timeframe;
    const isMaximized = this.manager.isIndicatorPaneMaximized();

    if (
      this.cachedBasePanesRef === basePanes
      && this.cachedPaneRendersRevision === revision
      && this.cachedPaneRendersTimeframe === timeframe
      && this.cachedPaneRendersMaximized === isMaximized
    ) {
      return this.cachedControllerPaneRenders;
    }

    const instances = new Map(this.manager.peekInstances().map((instance) => [instance.id, instance]));
    const result: IndicatorPaneRender[] = basePanes.map((pane) => {
      const instance = instances.get(pane.id);
      const definition = instance ? getIndicatorDefinition(instance.type) : undefined;
      const drawInteraction = definition?.drawInteraction
        ?? (definition?.drawSubPane === drawMultiSeries ? drawMultiSeriesInteraction : undefined);
      const requiresInteractionRedraw = Boolean(instance
        && LEGACY_CROSSHAIR_PANE_TYPES.has(instance.type)
        && !definition?.drawInteraction);
      if (!instance || !drawInteraction || !definition?.prepareData || definition?.inputSource === "view") {
        return requiresInteractionRedraw ? { ...pane, requiresInteractionRedraw: true } : pane;
      }
      return {
        ...pane,
        drawInteraction: (
          ctx: CanvasRenderingContext2D,
          view: View,
          series: FootprintSeries,
          rect: IndicatorPaneRect,
          range: [number, number],
          crosshair: IndicatorCrosshair,
        ) => {
          if (definition.inputSource === "view") return;
          const settings = { ...definition.defaultSettings(), ...instance.settings };
          const drawContext: IndicatorDrawContext<IndicatorSettings> = {
            ctx,
            view,
            series,
            rect,
            range,
            instance: instance as IndicatorInstance<IndicatorSettings>,
            settings,
            chart: this.options.getChartContext(),
            crosshair,
            requestRefresh: () => this.options.onInvalidate(),
            queuePriceLabel: this.options.queuePriceLabel,
          };
          const prepared = this.prepareInteractionData(instance, definition, drawContext);
          drawInteraction(drawContext, prepared);
        },
      };
    });

    this.cachedBasePanesRef = basePanes;
    this.cachedPaneRendersRevision = revision;
    this.cachedPaneRendersTimeframe = timeframe;
    this.cachedPaneRendersMaximized = isMaximized;
    this.cachedControllerPaneRenders = result;
    this.cachedRequiresInteractionRedraw = result.some((pane) => !pane.collapsed && pane.requiresInteractionRedraw === true);
    return result;
  }
  getPriceOverlayRenders(): ReturnType<IndicatorManager["getPriceOverlayRenders"]> { return this.manager.getPriceOverlayRenders(); }

  renderInteraction(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    range: [number, number],
    crosshair: IndicatorCrosshair,
  ): void {
    let top = view.area.top + view.area.height;
    for (const pane of this.getPaneRenders()) {
      const rect = { top, height: pane.height };
      if (!pane.collapsed) pane.drawInteraction?.(ctx, view, series, rect, range, crosshair);
      top += pane.height;
    }
  }

  requiresAnnotationInteractionRedraw(): boolean {
    this.getPaneRenders();
    return this.cachedRequiresInteractionRedraw;
  }

  private prepareInteractionData(
    instance: IndicatorInstance,
    definition: NonNullable<ReturnType<typeof getIndicatorDefinition>>,
    drawContext: IndicatorDrawContext<IndicatorSettings>,
  ): IndicatorPreparedData {
    const prepare = definition.prepareData!;
    const cachePolicy = definition.prepareCache;
    if (!cachePolicy) return prepare(drawContext);
    const maxAgeMs = typeof cachePolicy === "string" ? 0 : Math.max(1, cachePolicy.maxAgeMs);
    const timeBucket = maxAgeMs > 0 ? Math.floor(Date.now() / maxAgeMs) : 0;
    const chart = drawContext.chart;
    const cached = this.interactionPreparedCache.get(instance.id);
    if (cached
      && cached.definitionType === definition.type
      && cached.settings === instance.settings
      && cached.series === drawContext.series
      && cached.resetEpoch === drawContext.series.resetEpoch
      && cached.revision === drawContext.series.revision
      && cached.structureRevision === drawContext.series.structureRevision
      && cached.rangeFrom === drawContext.range[0]
      && cached.rangeTo === drawContext.range[1]
      && cached.market === (chart?.market ?? "")
      && cached.timeframe === (chart?.timeframe ?? "")
      && cached.intervalMs === (chart?.intervalMs ?? drawContext.series.config.intervalMs)
      && cached.timeBucket === timeBucket) {
      return cached.prepared;
    }
    const prepared = prepare(drawContext);
    this.interactionPreparedCache.set(instance.id, {
      definitionType: definition.type,
      settings: instance.settings,
      series: drawContext.series,
      resetEpoch: drawContext.series.resetEpoch,
      revision: drawContext.series.revision,
      structureRevision: drawContext.series.structureRevision,
      rangeFrom: drawContext.range[0],
      rangeTo: drawContext.range[1],
      market: chart?.market ?? "",
      timeframe: chart?.timeframe ?? "",
      intervalMs: chart?.intervalMs ?? drawContext.series.config.intervalMs,
      timeBucket,
      prepared,
    });
    return prepared;
  }

  scalePane(paneId: string, factorMultiplier: number): boolean { return this.manager.scalePane(paneId, factorMultiplier); }
  resetPaneScale(paneId: string): boolean { return this.manager.resetPaneScale(paneId); }
  togglePaneAutoScale(paneId: string): boolean { return this.manager.togglePaneAutoScale(paneId); }
  totalPaneHeight(availableHeight: number): number { return this.manager.totalPaneHeight(availableHeight); }
  layout(view: View): void {
    this.latestView = view;
    this.manager.layout(view);
  }
  dispose(): void {
    this.latestView = null;
    this.clearInteractionCache();
    this.manager.dispose();
  }
}
