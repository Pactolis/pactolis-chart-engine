import type { FootprintRenderer } from "../../core/render/footprintRenderer.js";
import type { Overlay } from "../../core/render/overlay.js";
import { ChartChange, ChartRenderScene } from "../../core/render/scene/chartScene.js";
import { ChartExtensionHost, createLayerExtension } from "../../core/render/scene/chartExtension.js";
import { buildBuiltInSceneLayers, buildIndicatorSceneLayer } from "../../core/render/scene/chartLayerPreset.js";
import type { ChartViewConfig } from "../../core/settings.js";
import type { IndicatorInstance } from "../indicators/types.js";
import type { ChartSession } from "./ChartSession.js";

export interface ChartRenderCoordinatorHost {
  readonly session: ChartSession;
  readonly overlay: Overlay;
  getRenderer(): FootprintRenderer;
  listIndicators(): IndicatorInstance[];
}

/** Owns chart scene extensions, layer ordering and render-surface invalidation policy. */
export class ChartRenderCoordinator {
  private readonly scene = new ChartRenderScene();
  private readonly extensionHost: ChartExtensionHost;
  private gpuLayerIds: ReadonlySet<string> = new Set();
  private annotationLayerOrder: readonly string[] = [];
  private interactionLayerOrder: readonly string[] = [];
  private appliedConfigKey = "";

  constructor(private readonly host: ChartRenderCoordinatorHost) {
    this.extensionHost = new ChartExtensionHost(this.scene, {
      invalidate: (changes = ChartChange.All) => this.host.session.invalidate(changes),
    });
  }

  /**
   * Pushes the effective view config to the renderer and overlay on every call (visibility
   * toggles and a restored WebGL renderer depend on it); the key only gates rebuilding the
   * scene's layer composition.
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
    // Cleared until the composition is fully rebuilt, so a throw mid-way lets the same config retry.
    this.appliedConfigKey = "";

    const extensions = [
      createLayerExtension("builtin-series", buildBuiltInSceneLayers(config.chartType)),
    ];
    for (let index = 0; index < indicators.length; index++) {
      const indicator = indicators[index];
      if (!indicator || indicator.visible === false) continue;
      extensions.push(createLayerExtension(
        `indicator:${indicator.id}`,
        [buildIndicatorSceneLayer(indicator.id, index)],
      ));
    }

    this.extensionHost.replace(extensions);
    this.gpuLayerIds = new Set(this.scene.layerIdsForSurface("gpu-scene"));
    this.annotationLayerOrder = this.scene.layerIdsForSurface("annotation");
    this.interactionLayerOrder = this.scene.layerIdsForSurface("interaction");
    this.appliedConfigKey = nextKey;
  }

  getGpuLayerIds(): ReadonlySet<string> { return this.gpuLayerIds; }
  getAnnotationLayerOrder(): readonly string[] { return this.annotationLayerOrder; }
  getInteractionLayerOrder(): readonly string[] { return this.interactionLayerOrder; }

  dispose(): void {
    this.extensionHost.dispose();
  }
}
