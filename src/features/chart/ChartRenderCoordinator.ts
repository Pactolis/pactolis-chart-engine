import type { FootprintRenderer } from "../../core/render/footprintRenderer.js";
import type { Overlay } from "../../core/render/overlay.js";
import { resolveLayerOrder } from "../../core/render/scene/chartLayerPreset.js";
import type { ChartViewConfig } from "../../core/settings.js";
import type { IndicatorInstance } from "../indicators/types.js";
import type { ChartSession } from "./ChartSession.js";

export interface ChartRenderCoordinatorHost {
  readonly session: ChartSession;
  readonly overlay: Overlay;
  getRenderer(): FootprintRenderer;
  listIndicators(): IndicatorInstance[];
}

/** Owns layer ordering and render-surface invalidation policy. */
export class ChartRenderCoordinator {
  private gpuLayerIds: ReadonlySet<string> = new Set();
  private annotationLayerOrder: readonly string[] = [];
  private interactionLayerOrder: readonly string[] = [];
  private appliedConfigKey = "";

  constructor(private readonly host: ChartRenderCoordinatorHost) {}

  /**
   * Pushes the effective view config to the renderer and overlay on every call (visibility
   * toggles and a restored WebGL renderer depend on it); the key only gates rebuilding the
   * layer composition.
   */
  applyConfig(config: ChartViewConfig): void {
    this.host.getRenderer().setChartConfig(config);
    this.host.overlay.setChartConfig(config);

    const indicators = this.host.listIndicators();
    const indicatorKey = indicators
      .map((indicator, index) => `${index}:${indicator.id}:${indicator.visible === false ? 0 : 1}`)
      .join("|");
    const nextKey = [
      config.chartType,
      config.tpoMode,
      config.tpoProfilePeriod,
      config.tpoBracketSize,
      config.clusterCellData,
      config.profileCellData,
      indicatorKey,
    ].join(";");
    if (nextKey === this.appliedConfigKey) return;
    this.appliedConfigKey = "";

    const visibleIds: string[] = [];
    for (const indicator of indicators) {
      if (indicator && indicator.visible !== false) {
        visibleIds.push(indicator.id);
      }
    }

    const resolved = resolveLayerOrder(config.chartType, visibleIds);
    this.gpuLayerIds = resolved.gpu;
    this.annotationLayerOrder = resolved.annotation;
    this.interactionLayerOrder = resolved.interaction;
    this.appliedConfigKey = nextKey;
  }

  getGpuLayerIds(): ReadonlySet<string> { return this.gpuLayerIds; }
  getAnnotationLayerOrder(): readonly string[] { return this.annotationLayerOrder; }
  getInteractionLayerOrder(): readonly string[] { return this.interactionLayerOrder; }

  dispose(): void {
    this.gpuLayerIds = new Set();
    this.annotationLayerOrder = [];
    this.interactionLayerOrder = [];
    this.appliedConfigKey = "";
  }
}
