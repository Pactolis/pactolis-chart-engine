import {
  ChartChange,
  type ChartLayer,
  type ChartRenderScene,
} from "./chartScene.js";

export interface ChartExtensionContext {
  invalidate(changes?: ChartChange): void;
}

/** Internal extension contract. Keep private to the application until stable. */
export interface ChartExtension {
  readonly id: string;
  attach(context: ChartExtensionContext): void;
  detach(): void;
  getLayers(): readonly ChartLayer[];
  getAutoscaleContribution?(): { min: number; max: number } | null;
  onPointerEvent?(event: unknown): boolean;
  onSelectionChanged?(selection: unknown): void;
}

export class ChartExtensionHost {
  private readonly extensions = new Map<string, ChartExtension>();
  private readonly layerIds = new Map<string, string[]>();

  constructor(
    private readonly scene: ChartRenderScene,
    private readonly context: ChartExtensionContext,
  ) {}

  add(extension: ChartExtension): void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`ChartExtensionHost: duplicate extension id '${extension.id}'`);
    }

    const addedLayers: string[] = [];
    extension.attach(this.context);
    try {
      for (const layer of extension.getLayers()) {
        this.scene.addLayer(layer);
        addedLayers.push(layer.id);
      }
    } catch (error) {
      for (let index = addedLayers.length - 1; index >= 0; index--) {
        this.scene.removeLayer(addedLayers[index]);
      }
      extension.detach();
      throw error;
    }

    this.extensions.set(extension.id, extension);
    this.layerIds.set(extension.id, addedLayers);
  }

  remove(id: string): boolean {
    const extension = this.extensions.get(id);
    if (!extension) return false;
    for (const layerId of this.layerIds.get(id) ?? []) this.scene.removeLayer(layerId);
    this.layerIds.delete(id);
    this.extensions.delete(id);
    extension.detach();
    return true;
  }

  replace(extensions: readonly ChartExtension[]): void {
    this.clear();
    for (const extension of extensions) this.add(extension);
  }

  clear(): void {
    for (const id of [...this.extensions.keys()]) this.remove(id);
  }

  has(id: string): boolean {
    return this.extensions.has(id);
  }

  dispose(): void {
    this.clear();
  }
}

export function createLayerExtension(id: string, layers: readonly ChartLayer[]): ChartExtension {
  return {
    id,
    attach() {},
    detach() {},
    getLayers: () => layers,
  };
}
