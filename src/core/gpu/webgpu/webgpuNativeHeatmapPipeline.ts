import type {
  GpuNativeHeatmapFrame,
  GpuNativeHeatmapPlot,
  GpuNativeHeatmapRect,
  GpuNativeHeatmapResidentFrame,
} from "../gpuBackend.js";
import {
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  recordPerformanceDuration,
} from "../../performanceTelemetry.js";
import {
  buildHeatmapPaletteWgslBranch,
  heatmapPaletteIndex,
} from "../../../features/orderbook/heatmapModel.js";

/** HeatmapCellRecord: 8 x 32-bit floats (32 bytes, 16-byte aligned). */
export const HEATMAP_CELL_RECORD_WORDS = 8;
export const HEATMAP_CELL_RECORD_BYTES = HEATMAP_CELL_RECORD_WORDS * 4;

/** ResidentHeatmapCell: 4 x 32-bit values (16 bytes, 16-byte aligned). */
export const RESIDENT_HEATMAP_CELL_WORDS = 4;
export const RESIDENT_HEATMAP_CELL_BYTES = RESIDENT_HEATMAP_CELL_WORDS * 4;

/** HeatmapUniform: 16 x 32-bit words (64 bytes, 16-byte aligned). */
export const HEATMAP_UNIFORM_WORDS = 16;
export const HEATMAP_UNIFORM_BYTES = HEATMAP_UNIFORM_WORDS * 4;

/** ResidentHeatmapUniforms: 16 x 32-bit words (64 bytes, 16-byte aligned). */
export const RESIDENT_HEATMAP_UNIFORM_WORDS = 16;
export const RESIDENT_HEATMAP_UNIFORM_BYTES = RESIDENT_HEATMAP_UNIFORM_WORDS * 4;

/** Tail cell capacity headroom allocated on resident full rebuilds to allow O(1) live/rollover updates. */
export const RESIDENT_HEATMAP_TAIL_HEADROOM = 4096;

/** Hard per-chart prototype budget matching HeatmapGpuRenderer (64 MiB). */
export const HEATMAP_WEBGPU_CHART_BUDGET_BYTES = 64 * 1024 * 1024;
/** Hard module-wide realm budget matching HeatmapGpuRenderer (256 MiB). */
export const HEATMAP_WEBGPU_MODULE_BUDGET_BYTES = 256 * 1024 * 1024;

const HEATMAP_MIN_CEILING_RATIO = 2;
const MAX_CELLS = 16 * 1024 * 1024;
/** Logical CPU payload per unleased prepared cell (matches GPU_PREPARED_CELL_PAYLOAD_BYTES). */
const KNOWN_FRAME_CELL_BYTES = 352;

let moduleReservedBytes = 0;

/** Diagnostic/test helper for verifying module-wide WebGPU heatmap budget ledger cleanliness. */
export function getWebGpuHeatmapModuleReservedBytesForTest(): number {
  return moduleReservedBytes;
}

export const NATIVE_HEATMAP_WGSL = `
struct HeatmapUniform {
  resolution: vec2<f32>,
  floor: f32,
  logSpan: f32,
  plotArea: vec4<f32>,
  opacity: f32,
  threshold: f32,
  cellCount: u32,
  paletteIndex: u32,
  pad1: vec4<f32>,
};

struct HeatmapCellRecord {
  x: f32,
  yTop: f32,
  width: f32,
  height: f32,
  value: f32,
  alphaScale: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> u_heatmap: HeatmapUniform;
@group(0) @binding(1) var<storage, read> cells: array<HeatmapCellRecord>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

var<private> UNIT_QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0)
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_idx: u32,
  @builtin(instance_index) instance_idx: u32,
) -> VertexOutput {
  var out: VertexOutput;
  if (instance_idx >= u_heatmap.cellCount) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let cell = cells[instance_idx];
  let value = cell.value;

  var k: f32 = 0.0;
  if (!(value > 0.0)) {
    k = 0.0;
  } else if (u_heatmap.floor > 0.0 && u_heatmap.logSpan > 0.0) {
    k = clamp(log2(value / u_heatmap.floor) * 0.30102999566398120 / u_heatmap.logSpan, 0.0, 1.0);
  } else if (u_heatmap.logSpan > 0.0) {
    k = clamp(log2(1.0 + (value / u_heatmap.logSpan) * 100.0) * 0.30102999566398120 / 2.0043213737826426, 0.0, 1.0);
  } else {
    k = clamp(log2(1.0 + value) * 0.30102999566398120 / 8.0, 0.0, 1.0);
  }

  var c0: vec3<f32>;
  var c1: vec3<f32>;
  var a0: f32;
  var a1: f32;
  var t: f32;
${buildHeatmapPaletteWgslBranch("u_heatmap.paletteIndex")}

  let rgb = floor(c0 + (c1 - c0) * t + 0.5) / 255.0;
  let raw_a = (a0 + (a1 - a0) * t) * cell.alphaScale * clamp(u_heatmap.opacity, 0.0, 1.0);
  let alpha = floor(clamp(raw_a, 0.0, 1.0) * 1000.0 + 0.5) / 1000.0;

  let unit = UNIT_QUAD[vertex_idx % 6u];
  let pos = vec2<f32>(cell.x, cell.yTop) + unit * vec2<f32>(cell.width, cell.height);
  let clip_x = (pos.x / u_heatmap.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_heatmap.resolution.y) * 2.0;

  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.color = vec4<f32>(rgb, alpha);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

export const NATIVE_RESIDENT_HEATMAP_WGSL = `
struct ResidentHeatmapUniforms {
  resolution: vec2<f32>,
  floor: f32,
  logSpan: f32,
  plotLeft: f32,
  plotTop: f32,
  plotWidth: f32,
  plotHeight: f32,
  opacity: f32,
  threshold: f32,
  offsetX: f32,
  colWidth: f32,
  priceTopRel: f32,
  pricePerPx: f32,
  bucketStep: f32,
  packedOffsetPalette: u32,
};

struct ResidentHeatmapCell {
  barIndex: u32,
  priceBinRel: f32,
  value: f32,
  flags: u32,
};

@group(0) @binding(0) var<uniform> u_resident: ResidentHeatmapUniforms;
@group(0) @binding(1) var<storage, read> residentCells: array<ResidentHeatmapCell>;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

var<private> RESIDENT_UNIT_QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0)
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_idx: u32,
  @builtin(instance_index) instance_idx: u32,
) -> VertexOutput {
  var out: VertexOutput;
  let baseCellOffset = u_resident.packedOffsetPalette & 0x00ffffffu;
  let paletteIndex = (u_resident.packedOffsetPalette >> 24u) & 0xffu;
  let cellIndex = baseCellOffset + instance_idx;
  if (cellIndex >= arrayLength(&residentCells)) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let cell = residentCells[cellIndex];
  let value = cell.value;
  if (!(value > 0.0) || (u_resident.threshold > 0.0 && value < u_resident.threshold)) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let plotLeft = u_resident.plotLeft;
  let plotTop = u_resident.plotTop;
  let plotRight = plotLeft + u_resident.plotWidth;
  let plotBottom = plotTop + u_resident.plotHeight;

  let x = plotLeft + u_resident.offsetX + f32(cell.barIndex) * u_resident.colWidth;
  let yTop = plotTop + (u_resident.priceTopRel - (cell.priceBinRel + u_resident.bucketStep)) / u_resident.pricePerPx;
  let height = max(1.0, u_resident.bucketStep / u_resident.pricePerPx);

  let rectX = x;
  let rectW = max(1.0, u_resident.colWidth);
  let alphaScale = 1.0;

  if (rectX + rectW < plotLeft || rectX > plotRight || yTop + height < plotTop || yTop > plotBottom) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  var k: f32 = 0.0;
  if (u_resident.floor > 0.0 && u_resident.logSpan > 0.0) {
    k = clamp(log2(value / u_resident.floor) * 0.30102999566398120 / u_resident.logSpan, 0.0, 1.0);
  } else if (u_resident.logSpan > 0.0) {
    k = clamp(log2(1.0 + (value / u_resident.logSpan) * 100.0) * 0.30102999566398120 / 2.0043213737826426, 0.0, 1.0);
  } else {
    k = clamp(log2(1.0 + value) * 0.30102999566398120 / 8.0, 0.0, 1.0);
  }

  var c0: vec3<f32>;
  var c1: vec3<f32>;
  var a0: f32;
  var a1: f32;
  var t: f32;
${buildHeatmapPaletteWgslBranch("paletteIndex")}

  let rgb = floor(c0 + (c1 - c0) * t + 0.5) / 255.0;
  let raw_a = (a0 + (a1 - a0) * t) * alphaScale * clamp(u_resident.opacity, 0.0, 1.0);
  let alpha = floor(clamp(raw_a, 0.0, 1.0) * 1000.0 + 0.5) / 1000.0;

  let unit = RESIDENT_UNIT_QUAD[vertex_idx % 6u];
  let pos = vec2<f32>(rectX, yTop) + unit * vec2<f32>(rectW, height);
  let clip_x = (pos.x / u_resident.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_resident.resolution.y) * 2.0;

  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.color = vec4<f32>(rgb, alpha);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

/**
 * WebGPU resident heatmap (CPU-projected rects; static-frame upload skip, pan/zoom re-uploads).
 * Cell screen rects `(x, yTop, width, height)` are projected on CPU each frame via `prepareReservedGpuCells`;
 * log-scale intensity, 4-stop palette ramp, RGB rounding and 3-decimal alpha quantization run in WGSL.
 */
export class WebGpuNativeHeatmapPipeline {
  readonly renderPipeline: any;
  readonly uniformBuffer: any;
  private readonly bindGroupLayout: any;
  private bindGroup: any = null;
  private cellBuffer: any = null;
  private cellCapacityBytes = 0;

  private stagingData: Float32Array | null = null;
  private stagingCapacityBytes = 0;
  private uploadedData: Float32Array | null = null;
  private uploadedDataReservedBytes = 0;
  private uploadedCellCount = -1;
  private uploadedDataKey = "";
  private uploadedContentRevision = -1;
  private uploadedMainRef: readonly GpuNativeHeatmapRect[] | null = null;
  private uploadedExtensionRef: readonly GpuNativeHeatmapRect[] | null = null;
  private uploadedMainCount = -1;
  private uploadedExtensionCount = -1;

  private readonly uniformRaw = new ArrayBuffer(HEATMAP_UNIFORM_BYTES);
  private readonly uniformF32 = new Float32Array(this.uniformRaw);
  private readonly uniformU32 = new Uint32Array(this.uniformRaw);
  private readonly uploadedUniformU32 = new Uint32Array(HEATMAP_UNIFORM_WORDS);
  private hasUploadedUniform = false;

  private reservedBytes = 0;
  private preparedLeaseBytes = 0;
  private readonly maxBufferSize: number;
  private disposed = false;

  public isDisposed(): boolean {
    return this.disposed;
  }

  private residentRenderPipeline: any = null;
  private residentBindGroupLayout: any = null;
  private residentUniformBuffer: any = null;
  private residentBindGroup: any = null;
  private residentCellBuffer: any = null;
  private residentCellCapacityCells = 0;
  private residentCellReservedBytes = 0;
  private residentStagingRaw: ArrayBuffer | null = null;
  private residentStagingU32: Uint32Array | null = null;
  private residentStagingF32: Float32Array | null = null;
  private residentStagingReservedBytes = 0;
  private residentSyncedGeneration = -1;
  private residentSyncedTailRevision = -1;
  private residentSyncedLiveBarIndex = -2;
  private residentSyncedBarCount = 0;
  private residentTotalCells = 0;
  private residentBarOffsets = new Int32Array(0);
  private residentBarCounts = new Int32Array(0);
  private residentBarSorted = new Uint8Array(0);
  private residentCellPriceRel: Float32Array | null = null;
  private residentCellPriceRelReservedBytes = 0;
  private residentCullSegStarts = new Int32Array(64);
  private residentCullSegCounts = new Int32Array(64);
  private readonly residentUniformRaw = new ArrayBuffer(RESIDENT_HEATMAP_UNIFORM_BYTES);
  private readonly residentUniformF32 = new Float32Array(this.residentUniformRaw);
  private readonly residentUniformU32 = new Uint32Array(this.residentUniformRaw);
  private readonly residentUploadedUniformU32 = new Uint32Array(RESIDENT_HEATMAP_UNIFORM_WORDS);
  private hasUploadedResidentUniform = false;

  constructor(
    private readonly device: any,
    public readonly format: string,
    maxBufferSize?: number,
  ) {
    this.maxBufferSize = maxBufferSize ?? device.limits?.maxBufferSize ?? 268435456;

    const module = device.createShaderModule({
      label: "NativeHeatmapShader",
      code: NATIVE_HEATMAP_WGSL,
    });

    this.uniformBuffer = device.createBuffer({
      label: "NativeHeatmapUniform",
      size: HEATMAP_UNIFORM_BYTES,
      usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
    });
    this.reserve(HEATMAP_UNIFORM_BYTES);

    this.bindGroupLayout = device.createBindGroupLayout({
      label: "NativeHeatmapBindGroupLayout",
      entries: [
        { binding: 0, visibility: 0x1, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x1, buffer: { type: "read-only-storage" } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "NativeHeatmapPipelineLayout",
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.renderPipeline = device.createRenderPipeline({
      label: "NativeHeatmapRenderPipeline",
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: "vs_main",
      },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    const initialBytes = Math.max(HEATMAP_CELL_RECORD_BYTES, 256 * HEATMAP_CELL_RECORD_BYTES);
    this.reserve(initialBytes);
    this.cellCapacityBytes = initialBytes;
    this.cellBuffer = this.device.createBuffer({
      label: "NativeHeatmapCellStorage",
      size: initialBytes,
      usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
    });
    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    this.bindGroup = this.device.createBindGroup({
      label: "NativeHeatmapBindGroup",
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.cellBuffer } },
      ],
    });
  }

  private reserve(deltaBytes: number): void {
    if (deltaBytes <= 0) return;
    if (
      this.reservedBytes + this.preparedLeaseBytes + deltaBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES
      || moduleReservedBytes + deltaBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES
    ) {
      throw new Error("Heatmap GPU prototype budget exceeded");
    }
    this.reservedBytes += deltaBytes;
    moduleReservedBytes += deltaBytes;
  }

  private releaseBytes(bytes: number): void {
    if (bytes <= 0) return;
    const chartRelease = Math.min(bytes, this.reservedBytes);
    this.reservedBytes -= chartRelease;
    moduleReservedBytes -= chartRelease;
  }

  reservePreparedPayload(logicalBytes: number): { release(): void } | null {
    if (this.disposed) return null;
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) return null;
    if (
      this.reservedBytes + this.preparedLeaseBytes + logicalBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES
      || moduleReservedBytes + logicalBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES
    ) {
      return null;
    }
    this.preparedLeaseBytes += logicalBytes;
    moduleReservedBytes += logicalBytes;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.preparedLeaseBytes -= logicalBytes;
        moduleReservedBytes -= logicalBytes;
      },
    };
  }

  renderFrame(
    targetTexture: any,
    bitmapWidth: number,
    bitmapHeight: number,
    dpr: number,
    frame: GpuNativeHeatmapFrame,
    plot: GpuNativeHeatmapPlot,
  ): boolean {
    if (this.disposed || !targetTexture) return false;
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      return this.submitFrame(targetTexture, bitmapWidth, bitmapHeight, dpr, frame, plot);
    } finally {
      if (startedAt !== null) {
        recordPerformanceDuration("chart.gpu.heatmap.render.ms", performance.now() - startedAt);
      }
    }
  }

  private submitFrame(
    targetTexture: any,
    bitmapWidth: number,
    bitmapHeight: number,
    dpr: number,
    frame: GpuNativeHeatmapFrame,
    plot: GpuNativeHeatmapPlot,
  ): boolean {
    const cells = frame.main.length + frame.extension.length;
    if (cells === 0) return true;
    if (!Number.isFinite(cells) || cells > MAX_CELLS) return false;

    const f32 = (n: number): boolean => Number.isFinite(n) && Number.isFinite(Math.fround(n));
    const pos = (n: number): boolean => f32(n) && n > 0 && Math.fround(n) > 0;
    const val = (n: number): boolean => f32(n) && n >= 0 && !(n > 0 && Math.fround(n) === 0);

    const canFastReuseUploaded =
      this.cellBuffer !== null
      && frame.contentRevision !== undefined
      && Number.isSafeInteger(frame.contentRevision)
      && frame.contentRevision >= 0
      && frame.contentRevision === this.uploadedContentRevision
      && frame.dataKey === this.uploadedDataKey
      && frame.main === this.uploadedMainRef
      && frame.extension === this.uploadedExtensionRef
      && frame.main.length === this.uploadedMainCount
      && frame.extension.length === this.uploadedExtensionCount
      && this.uploadedCellCount === cells;

    if (!canFastReuseUploaded) {
      for (const rect of frame.main) {
        if (!f32(rect.x) || !f32(rect.yTop) || !pos(rect.width) || !pos(rect.height) || !val(rect.value)) {
          return false;
        }
      }
      for (const rect of frame.extension) {
        if (!f32(rect.x) || !f32(rect.yTop) || !pos(rect.width) || !pos(rect.height) || !val(rect.value)) {
          return false;
        }
        if (
          rect.sourceMainIndex === undefined
          || rect.sourceMainIndex < 0
          || rect.sourceMainIndex >= frame.main.length
          || !Number.isInteger(rect.sourceMainIndex)
        ) {
          return false;
        }
      }
    }

    const floor = frame.floor ?? frame.threshold;
    const opacity = frame.opacity ?? 1;
    if (!val(frame.threshold) || !val(frame.ceiling) || !val(floor)) return false;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
    if (!(plot.width > 0) || !(plot.height > 0)) return false;

    const effectiveDpr = plot.pixelRatio !== undefined && plot.pixelRatio > 0 ? plot.pixelRatio : dpr;
    if (!(bitmapWidth > 0) || !(bitmapHeight > 0) || !(effectiveDpr > 0)) return false;

    const ceiling = floor > 0 ? Math.max(frame.ceiling, floor * HEATMAP_MIN_CEILING_RATIO) : frame.ceiling;
    if (!f32(floor) || !f32(ceiling) || !f32(opacity)) return false;
    const logSpan = floor > 0 ? Math.log10(ceiling / floor) : (ceiling > 0 ? ceiling : 0);
    if (!Number.isFinite(logSpan)) return false;

    const scissorX = Math.round(plot.left * effectiveDpr);
    const scissorY = Math.round(plot.top * effectiveDpr);
    const scissorW = Math.round(plot.width * effectiveDpr);
    const scissorH = Math.round(plot.height * effectiveDpr);
    if (
      !(scissorW > 0)
      || !(scissorH > 0)
      || scissorX < 0
      || scissorY < 0
      || scissorX + scissorW > bitmapWidth
      || scissorY + scissorH > bitmapHeight
    ) {
      return false;
    }

    const framePayloadBytes = frame.preparedLease === undefined ? cells * KNOWN_FRAME_CELL_BYTES : 0;
    if (framePayloadBytes > 0) {
      if (
        this.reservedBytes + this.preparedLeaseBytes + framePayloadBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES
        || moduleReservedBytes + framePayloadBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES
      ) {
        return false;
      }
      this.reservedBytes += framePayloadBytes;
      moduleReservedBytes += framePayloadBytes;
    }

    try {
      if (!canFastReuseUploaded) {
        const neededBytes = cells * HEATMAP_CELL_RECORD_BYTES;
        if (neededBytes > this.maxBufferSize) return false;

        this.ensureStagingAndStorage(neededBytes);
        const data = this.stagingData!;

        let offset = 0;
        const writeCell = (rect: GpuNativeHeatmapRect, value: number, alphaScale: number): void => {
          data[offset] = rect.x;
          data[offset + 1] = rect.yTop;
          data[offset + 2] = rect.width;
          data[offset + 3] = rect.height;
          data[offset + 4] = value;
          data[offset + 5] = alphaScale;
          data[offset + 6] = 0;
          data[offset + 7] = 0;
          offset += HEATMAP_CELL_RECORD_WORDS;
        };

        let nextExt = 0;
        for (let i = 0; i < frame.main.length; i++) {
          const mainRect = frame.main[i];
          writeCell(mainRect, mainRect.value, 1);
          while (nextExt < frame.extension.length && frame.extension[nextExt].sourceMainIndex === i) {
            writeCell(frame.extension[nextExt], mainRect.value, 0.45);
            nextExt++;
          }
        }
        if (nextExt !== frame.extension.length) return false;

        const activeView = data.subarray(0, cells * HEATMAP_CELL_RECORD_WORDS);
        const uploaded = this.uploadedData;
        const sameLayout =
          uploaded !== null
          && this.uploadedDataKey === frame.dataKey
          && this.uploadedCellCount === cells
          && uploaded.length === activeView.length;

        if (sameLayout) {
          let firstDirtyWord = -1;
          let lastDirtyWord = -1;
          for (let i = 0; i < activeView.length; i++) {
            if (uploaded[i] !== activeView[i]) {
              if (firstDirtyWord === -1) firstDirtyWord = i;
              lastDirtyWord = i;
            }
          }
          if (firstDirtyWord !== -1) {
            const firstCell = Math.floor(firstDirtyWord / HEATMAP_CELL_RECORD_WORDS);
            const lastCell = Math.floor(lastDirtyWord / HEATMAP_CELL_RECORD_WORDS);
            const firstWord = firstCell * HEATMAP_CELL_RECORD_WORDS;
            const endWord = (lastCell + 1) * HEATMAP_CELL_RECORD_WORDS;
            const byteOffset = firstCell * HEATMAP_CELL_RECORD_BYTES;
            const dirtyBytes = (lastCell - firstCell + 1) * HEATMAP_CELL_RECORD_BYTES;
            this.device.queue.writeBuffer(this.cellBuffer, byteOffset, data.buffer, byteOffset, dirtyBytes);
            incrementPerformanceCounter("gpu.upload.bytes", dirtyBytes);
            incrementPerformanceCounter("gpu.native.heatmap.upload.bytes", dirtyBytes);
            uploaded.set(activeView.subarray(firstWord, endWord), firstWord);
          }
        } else {
          const uploadBytes = cells * HEATMAP_CELL_RECORD_BYTES;
          this.device.queue.writeBuffer(this.cellBuffer, 0, data.buffer, 0, uploadBytes);
          incrementPerformanceCounter("gpu.upload.bytes", uploadBytes);
          incrementPerformanceCounter("gpu.native.heatmap.upload.bytes", uploadBytes);

          if (!this.uploadedData || this.uploadedData.length !== activeView.length) {
            const oldRetained = this.uploadedDataReservedBytes;
            this.reserve(uploadBytes);
            this.uploadedDataReservedBytes = uploadBytes;
            this.uploadedData = new Float32Array(activeView.length);
            this.releaseBytes(oldRetained);
          }
          this.uploadedData.set(activeView);
          this.uploadedCellCount = cells;
          this.uploadedDataKey = frame.dataKey;
        }
      }

      this.uniformF32[0] = bitmapWidth / effectiveDpr;
      this.uniformF32[1] = bitmapHeight / effectiveDpr;
      this.uniformF32[2] = floor;
      this.uniformF32[3] = logSpan;
      this.uniformF32[4] = plot.left;
      this.uniformF32[5] = plot.top;
      this.uniformF32[6] = plot.width;
      this.uniformF32[7] = plot.height;
      this.uniformF32[8] = opacity;
      this.uniformF32[9] = frame.threshold;
      this.uniformU32[10] = cells;
      this.uniformU32[11] = heatmapPaletteIndex(frame.palette) >>> 0;
      this.uniformF32[12] = 0;
      this.uniformF32[13] = 0;
      this.uniformF32[14] = 0;
      this.uniformF32[15] = 0;

      let needsUniformUpload = !this.hasUploadedUniform;
      if (!needsUniformUpload) {
        for (let i = 0; i < HEATMAP_UNIFORM_WORDS; i++) {
          if (this.uploadedUniformU32[i] !== this.uniformU32[i]) {
            needsUniformUpload = true;
            break;
          }
        }
      }
      if (needsUniformUpload) {
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformRaw, 0, HEATMAP_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.upload.bytes", HEATMAP_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.native.heatmap.upload.bytes", HEATMAP_UNIFORM_BYTES);
        this.uploadedUniformU32.set(this.uniformU32);
        this.hasUploadedUniform = true;
      }

      const commandEncoder = this.device.createCommandEncoder({
        label: "WebGpuNativeHeatmapCommandEncoder",
      });
      const passEncoder = commandEncoder.beginRenderPass({
        label: "WebGpuNativeHeatmapRenderPass",
        colorAttachments: [
          {
            view: targetTexture.createView ? targetTexture.createView() : targetTexture,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      passEncoder.setScissorRect?.(scissorX, scissorY, scissorW, scissorH);
      passEncoder.setPipeline(this.renderPipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6, cells, 0, 0);
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);
      if (!canFastReuseUploaded) {
        if (
          frame.contentRevision !== undefined
          && Number.isSafeInteger(frame.contentRevision)
          && frame.contentRevision >= 0
        ) {
          this.uploadedContentRevision = frame.contentRevision;
          this.uploadedMainRef = frame.main;
          this.uploadedExtensionRef = frame.extension;
          this.uploadedMainCount = frame.main.length;
          this.uploadedExtensionCount = frame.extension.length;
        } else {
          this.uploadedContentRevision = -1;
          this.uploadedMainRef = null;
          this.uploadedExtensionRef = null;
          this.uploadedMainCount = -1;
          this.uploadedExtensionCount = -1;
        }
      }
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
        throw error;
      }
      this.dispose();
      return false;
    } finally {
      this.releaseBytes(framePayloadBytes);
    }
  }

  /**
   * GPU-resident vertex-projected heatmap render path:
   * stores sparse `(barIndex, priceBinRel, value, flags)` cells (`16 B/cell`) in device memory,
   * skips cell data uploads on pan/zoom (`0 B` data upload), and projects screen quads in WGSL.
   */
  renderResidentFrame(
    targetTexture: any,
    bitmapWidth: number,
    bitmapHeight: number,
    dpr: number,
    frame: GpuNativeHeatmapResidentFrame,
    plot: GpuNativeHeatmapPlot,
  ): boolean {
    if (this.disposed || !targetTexture) return false;
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      return this.submitResidentFrame(targetTexture, bitmapWidth, bitmapHeight, dpr, frame, plot);
    } finally {
      if (startedAt !== null) {
        recordPerformanceDuration("chart.gpu.heatmap.render.ms", performance.now() - startedAt);
      }
    }
  }

  private ensureResidentPipelineResources(): boolean {
    if (this.residentRenderPipeline && this.residentUniformBuffer && this.residentCellBuffer) {
      return true;
    }

    if (!this.residentUniformBuffer) {
      this.reserve(RESIDENT_HEATMAP_UNIFORM_BYTES);
      this.residentUniformBuffer = this.device.createBuffer({
        label: "NativeResidentHeatmapUniform",
        size: RESIDENT_HEATMAP_UNIFORM_BYTES,
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }

    if (!this.residentRenderPipeline) {
      const module = this.device.createShaderModule({
        label: "NativeResidentHeatmapShader",
        code: NATIVE_RESIDENT_HEATMAP_WGSL,
      });

      this.residentBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeResidentHeatmapBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x1, buffer: { type: "read-only-storage" } },
        ],
      });

      const pipelineLayout = this.device.createPipelineLayout({
        label: "NativeResidentHeatmapPipelineLayout",
        bindGroupLayouts: [this.residentBindGroupLayout],
      });

      this.residentRenderPipeline = this.device.createRenderPipeline({
        label: "NativeResidentHeatmapRenderPipeline",
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "vs_main",
        },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [
            {
              format: this.format,
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add",
                },
                alpha: {
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add",
                },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });
    }

    return this.ensureResidentStorageCells(0);
  }

  private ensureResidentBarMetadata(barCount: number, preservePrefixCount = 0): void {
    if (this.residentBarOffsets.length >= barCount) return;
    let nextCap = Math.max(256, this.residentBarOffsets.length || 256);
    while (nextCap < barCount) nextCap *= 2;
    const nextOffsets = new Int32Array(nextCap);
    const nextCounts = new Int32Array(nextCap);
    const nextSorted = new Uint8Array(nextCap);
    if (preservePrefixCount > 0) {
      nextOffsets.set(this.residentBarOffsets.subarray(0, preservePrefixCount));
      nextCounts.set(this.residentBarCounts.subarray(0, preservePrefixCount));
      nextSorted.set(this.residentBarSorted.subarray(0, preservePrefixCount));
    }
    this.residentBarOffsets = nextOffsets;
    this.residentBarCounts = nextCounts;
    this.residentBarSorted = nextSorted;
  }

  private ensureResidentPriceIndexCells(minCells: number): void {
    const neededCells = Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, minCells);
    if (this.residentCellPriceRel && this.residentCellPriceRel.length >= neededCells) {
      return;
    }
    let nextCells = Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, this.residentCellPriceRel?.length || RESIDENT_HEATMAP_TAIL_HEADROOM);
    while (nextCells < neededCells) nextCells *= 2;
    const nextBytes = nextCells * 4;
    const oldBytes = this.residentCellPriceRelReservedBytes;
    const netChartBytes = this.reservedBytes - oldBytes + this.preparedLeaseBytes + nextBytes;
    const netModuleBytes = moduleReservedBytes - oldBytes + nextBytes;
    if (netChartBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES || netModuleBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES) {
      throw new Error("Heatmap GPU prototype budget exceeded");
    }
    const prev = this.residentCellPriceRel;
    const next = new Float32Array(nextCells);
    if (prev) next.set(prev);
    this.releaseBytes(oldBytes);
    this.reserve(nextBytes);
    this.residentCellPriceRel = next;
    this.residentCellPriceRelReservedBytes = nextBytes;
  }

  private recordResidentBarPrices(
    dstCellOffset: number,
    barIndex: number,
    priceOrigin: number,
    cells: ReturnType<GpuNativeHeatmapResidentFrame["readBarCells"]>,
  ): void {
    this.ensureResidentPriceIndexCells(dstCellOffset + cells.length);
    const prices = this.residentCellPriceRel!;
    let sorted = 1;
    let prevPrice = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < cells.length; i++) {
      const rel = Math.fround(cells[i].priceStart - priceOrigin);
      prices[dstCellOffset + i] = rel;
      if (rel < prevPrice) sorted = 0;
      prevPrice = rel;
    }
    this.residentBarSorted[barIndex] = sorted;
  }

  private ensureResidentStagingCells(minCells: number): void {
    const neededCells = Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, minCells);
    if (this.residentStagingU32 && this.residentStagingU32.length >= neededCells * RESIDENT_HEATMAP_CELL_WORDS) {
      return;
    }
    let nextCells = Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, this.residentStagingReservedBytes / RESIDENT_HEATMAP_CELL_BYTES || RESIDENT_HEATMAP_TAIL_HEADROOM);
    while (nextCells < neededCells) nextCells *= 2;
    const nextBytes = nextCells * RESIDENT_HEATMAP_CELL_BYTES;
    const oldBytes = this.residentStagingReservedBytes;
    const netChartBytes = this.reservedBytes - oldBytes + this.preparedLeaseBytes + nextBytes;
    const netModuleBytes = moduleReservedBytes - oldBytes + nextBytes;
    if (netChartBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES || netModuleBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES) {
      throw new Error("Heatmap GPU prototype budget exceeded");
    }
    const prevU32 = this.residentStagingU32;
    const nextRaw = new ArrayBuffer(nextBytes);
    const nextU32 = new Uint32Array(nextRaw);
    const nextF32 = new Float32Array(nextRaw);
    if (prevU32) nextU32.set(prevU32);
    this.releaseBytes(oldBytes);
    this.reserve(nextBytes);
    this.residentStagingRaw = nextRaw;
    this.residentStagingU32 = nextU32;
    this.residentStagingF32 = nextF32;
    this.residentStagingReservedBytes = nextBytes;
  }

  private ensureResidentStorageCells(minCells: number): boolean {
    if (this.residentCellBuffer && minCells <= this.residentCellCapacityCells) {
      return true;
    }
    const maxCellsByDevice = Math.floor(this.maxBufferSize / RESIDENT_HEATMAP_CELL_BYTES);
    if (minCells > maxCellsByDevice) return false;
    let targetCells = Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, this.residentCellCapacityCells || RESIDENT_HEATMAP_TAIL_HEADROOM);
    const requiredWithHeadroom = Math.min(maxCellsByDevice, Math.max(RESIDENT_HEATMAP_TAIL_HEADROOM, minCells + RESIDENT_HEATMAP_TAIL_HEADROOM));
    while (targetCells < requiredWithHeadroom && targetCells * 2 <= maxCellsByDevice) {
      targetCells *= 2;
    }
    if (targetCells < requiredWithHeadroom) targetCells = requiredWithHeadroom;
    const nextCapBytes = targetCells * RESIDENT_HEATMAP_CELL_BYTES;
    const oldBytes = this.residentCellReservedBytes;
    const netChartBytes = this.reservedBytes - oldBytes + this.preparedLeaseBytes + nextCapBytes;
    const netModuleBytes = moduleReservedBytes - oldBytes + nextCapBytes;
    if (netChartBytes > HEATMAP_WEBGPU_CHART_BUDGET_BYTES || netModuleBytes > HEATMAP_WEBGPU_MODULE_BUDGET_BYTES) {
      throw new Error("Heatmap GPU prototype budget exceeded");
    }

    const oldBuffer = this.residentCellBuffer;
    const nextBuffer = this.device.createBuffer({
      label: "NativeResidentHeatmapCellStorage",
      size: nextCapBytes,
      usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
    });
    oldBuffer?.destroy?.();
    this.releaseBytes(oldBytes);
    this.reserve(nextCapBytes);
    this.residentCellBuffer = nextBuffer;
    this.residentCellCapacityCells = targetCells;
    this.residentCellReservedBytes = nextCapBytes;
    this.residentBindGroup = this.device.createBindGroup({
      label: "NativeResidentHeatmapBindGroup",
      layout: this.residentBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.residentUniformBuffer } },
        { binding: 1, resource: { buffer: this.residentCellBuffer } },
      ],
    });
    return true;
  }

  private packResidentCellsIntoStaging(
    stagingOffsetCells: number,
    barIndex: number,
    priceOrigin: number,
    cells: ReturnType<GpuNativeHeatmapResidentFrame["readBarCells"]>,
  ): number {
    this.ensureResidentStagingCells(stagingOffsetCells + cells.length);
    const u32 = this.residentStagingU32!;
    const f32 = this.residentStagingF32!;
    let word = stagingOffsetCells * RESIDENT_HEATMAP_CELL_WORDS;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      u32[word] = barIndex >>> 0;
      f32[word + 1] = cell.priceStart - priceOrigin;
      f32[word + 2] = cell.value;
      u32[word + 3] = cell.liveEligible ? 1 : 0;
      word += RESIDENT_HEATMAP_CELL_WORDS;
    }
    return cells.length;
  }

  private uploadResidentDataSlice(dstCellOffset: number, stagingCellCount: number): void {
    if (stagingCellCount <= 0) return;
    const uploadBytes = stagingCellCount * RESIDENT_HEATMAP_CELL_BYTES;
    const dstByteOffset = dstCellOffset * RESIDENT_HEATMAP_CELL_BYTES;
    this.device.queue.writeBuffer(this.residentCellBuffer, dstByteOffset, this.residentStagingRaw!, 0, uploadBytes);
    incrementPerformanceCounter("gpu.upload.bytes", uploadBytes);
    incrementPerformanceCounter("gpu.native.heatmap.dataBytes", uploadBytes);
  }

  private submitResidentFrame(
    targetTexture: any,
    bitmapWidth: number,
    bitmapHeight: number,
    dpr: number,
    frame: GpuNativeHeatmapResidentFrame,
    plot: GpuNativeHeatmapPlot,
  ): boolean {
    const f32Check = (n: number): boolean => Number.isFinite(n) && Number.isFinite(Math.fround(n));
    const posCheck = (n: number): boolean => f32Check(n) && n > 0 && Math.fround(n) > 0;
    const valCheck = (n: number): boolean => f32Check(n) && n >= 0 && !(n > 0 && Math.fround(n) === 0);

    if (!Number.isInteger(frame.barCount) || frame.barCount < 0) return false;
    if (!f32Check(frame.priceOrigin) || !posCheck(frame.bucketStep)) return false;
    if (!valCheck(frame.threshold) || !valCheck(frame.ceiling) || !valCheck(frame.floor)) return false;
    if (!Number.isFinite(frame.opacity) || frame.opacity < 0 || frame.opacity > 1) return false;
    if (
      !f32Check(frame.view.offsetX)
      || !posCheck(frame.view.colWidth)
      || !f32Check(frame.view.priceTop)
      || !posCheck(frame.view.pricePerPx)
    ) {
      return false;
    }
    if (!(plot.width > 0) || !(plot.height > 0)) return false;

    const effectiveDpr = plot.pixelRatio !== undefined && plot.pixelRatio > 0 ? plot.pixelRatio : dpr;
    if (!(bitmapWidth > 0) || !(bitmapHeight > 0) || !(effectiveDpr > 0)) return false;

    const floor = frame.floor;
    const ceiling = floor > 0 ? Math.max(frame.ceiling, floor * HEATMAP_MIN_CEILING_RATIO) : frame.ceiling;
    if (!f32Check(floor) || !f32Check(ceiling) || !f32Check(frame.opacity)) return false;
    const logSpan = floor > 0 ? Math.log10(ceiling / floor) : (ceiling > 0 ? ceiling : 0);
    if (!Number.isFinite(logSpan)) return false;

    const scissorX = Math.round(plot.left * effectiveDpr);
    const scissorY = Math.round(plot.top * effectiveDpr);
    const scissorW = Math.round(plot.width * effectiveDpr);
    const scissorH = Math.round(plot.height * effectiveDpr);
    if (
      !(scissorW > 0)
      || !(scissorH > 0)
      || scissorX < 0
      || scissorY < 0
      || scissorX + scissorW > bitmapWidth
      || scissorY + scissorH > bitmapHeight
    ) {
      return false;
    }

    try {
      if (!this.ensureResidentPipelineResources()) return false;

      const sameGeneration = this.residentSyncedGeneration !== -1 && frame.syncGeneration === this.residentSyncedGeneration;
      const needsSync =
        !sameGeneration
        || frame.tailSyncRevision !== this.residentSyncedTailRevision
        || frame.barCount !== this.residentSyncedBarCount
        || frame.liveBarIndex !== this.residentSyncedLiveBarIndex;

      if (needsSync) {
        let incrementalDone = false;
        let syncedBarsCount = 0;
        const dirtyFrom = frame.dirtyFromBarIndex;
        const canUseDirtyWindow =
          dirtyFrom !== undefined
          && dirtyFrom >= Math.max(0, frame.barCount - 12)
          && dirtyFrom < frame.barCount;

        if (
          sameGeneration
          && frame.liveBarIndex >= 0
          && frame.liveBarIndex === this.residentSyncedLiveBarIndex
          && frame.barCount === this.residentSyncedBarCount
          && frame.liveBarIndex === this.residentSyncedBarCount - 1
          && (dirtyFrom === undefined || dirtyFrom >= frame.liveBarIndex)
        ) {
          const tailOffset = this.residentBarOffsets[frame.liveBarIndex];
          const tailCells = frame.readBarCells(frame.liveBarIndex);
          if (tailOffset >= 0 && tailOffset + tailCells.length <= this.residentCellCapacityCells) {
            this.packResidentCellsIntoStaging(0, frame.liveBarIndex, frame.priceOrigin, tailCells);
            this.recordResidentBarPrices(tailOffset, frame.liveBarIndex, frame.priceOrigin, tailCells);
            this.uploadResidentDataSlice(tailOffset, tailCells.length);
            this.residentBarCounts[frame.liveBarIndex] = tailCells.length;
            this.residentTotalCells = tailOffset + tailCells.length;
            this.residentSyncedTailRevision = frame.tailSyncRevision;
            syncedBarsCount = 1;
            incrementalDone = true;
          }
        } else if (
          sameGeneration
          && frame.barCount === this.residentSyncedBarCount
          && canUseDirtyWindow
          && this.residentBarOffsets[dirtyFrom!] >= 0
        ) {
          const startBar = dirtyFrom!;
          const startOffset = this.residentBarOffsets[startBar];
          let sliceCells = 0;
          for (let b = startBar; b < frame.barCount; b++) {
            const barCells = frame.readBarCells(b);
            this.residentBarOffsets[b] = startOffset + sliceCells;
            this.residentBarCounts[b] = barCells.length;
            this.packResidentCellsIntoStaging(sliceCells, b, frame.priceOrigin, barCells);
            this.recordResidentBarPrices(startOffset + sliceCells, b, frame.priceOrigin, barCells);
            sliceCells += barCells.length;
          }
          if (startOffset + sliceCells <= this.residentCellCapacityCells) {
            this.uploadResidentDataSlice(startOffset, sliceCells);
            this.residentTotalCells = startOffset + sliceCells;
            this.residentSyncedLiveBarIndex = frame.liveBarIndex;
            this.residentSyncedTailRevision = frame.tailSyncRevision;
            syncedBarsCount = frame.barCount - startBar;
            incrementalDone = true;
          }
        } else if (
          sameGeneration
          && this.residentSyncedLiveBarIndex >= 0
          && frame.liveBarIndex === this.residentSyncedLiveBarIndex + 1
          && this.residentSyncedBarCount === this.residentSyncedLiveBarIndex + 1
          && frame.barCount >= frame.liveBarIndex + 1
        ) {
          const prevLive = this.residentSyncedLiveBarIndex;
          const startBar = canUseDirtyWindow && dirtyFrom! < prevLive ? dirtyFrom! : prevLive;
          const prevOffset = this.residentBarOffsets[startBar];
          if (prevOffset >= 0) {
            let sliceCells = 0;
            this.ensureResidentBarMetadata(frame.barCount, startBar);
            for (let b = startBar; b < frame.barCount; b++) {
              const barCells = frame.readBarCells(b);
              this.residentBarOffsets[b] = prevOffset + sliceCells;
              this.residentBarCounts[b] = barCells.length;
              this.packResidentCellsIntoStaging(sliceCells, b, frame.priceOrigin, barCells);
              this.recordResidentBarPrices(prevOffset + sliceCells, b, frame.priceOrigin, barCells);
              sliceCells += barCells.length;
            }
            if (prevOffset + sliceCells <= this.residentCellCapacityCells) {
              this.uploadResidentDataSlice(prevOffset, sliceCells);
              this.residentTotalCells = prevOffset + sliceCells;
              this.residentSyncedLiveBarIndex = frame.liveBarIndex;
              this.residentSyncedBarCount = frame.barCount;
              this.residentSyncedTailRevision = frame.tailSyncRevision;
              syncedBarsCount = frame.barCount - startBar;
              incrementalDone = true;
            }
          }
        }

        if (incrementalDone) {
          incrementPerformanceCounter("gpu.native.heatmap.sync.tail");
          incrementPerformanceCounter("gpu.native.heatmap.sync.bars", syncedBarsCount);
        } else {
          this.ensureResidentBarMetadata(frame.barCount, 0);
          let totalCells = 0;
          for (let b = 0; b < frame.barCount; b++) {
            const barCells = frame.readBarCells(b);
            this.residentBarOffsets[b] = totalCells;
            this.residentBarCounts[b] = barCells.length;
            this.packResidentCellsIntoStaging(totalCells, b, frame.priceOrigin, barCells);
            this.recordResidentBarPrices(totalCells, b, frame.priceOrigin, barCells);
            totalCells += barCells.length;
          }
          if (totalCells > MAX_CELLS) return false;
          if (!this.ensureResidentStorageCells(totalCells)) return false;
          this.uploadResidentDataSlice(0, totalCells);
          this.residentTotalCells = totalCells;
          this.residentSyncedGeneration = frame.syncGeneration;
          this.residentSyncedTailRevision = frame.tailSyncRevision;
          this.residentSyncedLiveBarIndex = frame.liveBarIndex;
          this.residentSyncedBarCount = frame.barCount;
          incrementPerformanceCounter("gpu.native.heatmap.sync.full");
          incrementPerformanceCounter("gpu.native.heatmap.sync.bars", frame.barCount);
        }
      }

      if (this.residentSyncedBarCount === 0 || this.residentTotalCells === 0) {
        return true;
      }

      const visStartBar = Math.max(0, Math.min(this.residentSyncedBarCount - 1, Math.floor(frame.visibleRange[0])));
      const visEndBar = Math.max(-1, Math.min(this.residentSyncedBarCount - 1, Math.ceil(frame.visibleRange[1])));
      if (visEndBar < visStartBar) return true;

      const visibleCellOffset = this.residentBarOffsets[visStartBar];
      const endCell = visEndBar === this.residentSyncedBarCount - 1
        ? this.residentTotalCells
        : this.residentBarOffsets[visEndBar + 1];
      const visibleCellCount = Math.max(0, endCell - visibleCellOffset);
      if (visibleCellCount === 0) return true;
      if (visibleCellOffset > 0x00ffffff) return false;

      this.residentUniformF32[0] = bitmapWidth / effectiveDpr;
      this.residentUniformF32[1] = bitmapHeight / effectiveDpr;
      this.residentUniformF32[2] = floor;
      this.residentUniformF32[3] = logSpan;
      this.residentUniformF32[4] = plot.left;
      this.residentUniformF32[5] = plot.top;
      this.residentUniformF32[6] = plot.width;
      this.residentUniformF32[7] = plot.height;
      this.residentUniformF32[8] = frame.opacity;
      this.residentUniformF32[9] = frame.threshold;
      this.residentUniformF32[10] = frame.view.offsetX;
      this.residentUniformF32[11] = frame.view.colWidth;
      this.residentUniformF32[12] = frame.view.priceTop - frame.priceOrigin;
      this.residentUniformF32[13] = frame.view.pricePerPx;
      this.residentUniformF32[14] = frame.bucketStep;
      this.residentUniformU32[15] = ((heatmapPaletteIndex(frame.palette) & 0xff) << 24) | (visibleCellOffset & 0x00ffffff);

      let needsUniformUpload = !this.hasUploadedResidentUniform;
      if (!needsUniformUpload) {
        for (let i = 0; i < RESIDENT_HEATMAP_UNIFORM_WORDS; i++) {
          if (this.residentUploadedUniformU32[i] !== this.residentUniformU32[i]) {
            needsUniformUpload = true;
            break;
          }
        }
      }
      if (needsUniformUpload) {
        this.device.queue.writeBuffer(this.residentUniformBuffer, 0, this.residentUniformRaw, 0, RESIDENT_HEATMAP_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.upload.bytes", RESIDENT_HEATMAP_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.native.heatmap.uniformBytes", RESIDENT_HEATMAP_UNIFORM_BYTES);
        this.residentUploadedUniformU32.set(this.residentUniformU32);
        this.hasUploadedResidentUniform = true;
      }

      let segCount = 0;
      let culledTotalCells = visibleCellCount;
      let useVerticalSegments = false;
      const priceRelArr = this.residentCellPriceRel;
      if (visibleCellCount >= 256 && visEndBar - visStartBar + 1 <= 256 && priceRelArr !== null) {
        const priceTopRel = frame.view.priceTop - frame.priceOrigin;
        const eps = 1e-4 * Math.max(1, Math.abs(priceTopRel), frame.bucketStep);
        const minPriceRel = priceTopRel - plot.height * frame.view.pricePerPx - frame.bucketStep - eps;
        const maxPriceRel = priceTopRel - frame.bucketStep + Math.max(frame.view.pricePerPx, frame.bucketStep) + eps;
        let sumCulled = 0;
        for (let b = visStartBar; b <= visEndBar; b++) {
          const barCount = this.residentBarCounts[b];
          if (barCount <= 0) continue;
          const barOff = this.residentBarOffsets[b];
          let segStart = barOff;
          let segEnd = barOff + barCount;
          if (this.residentBarSorted[b] === 1) {
            let l = barOff;
            let r = barOff + barCount;
            while (l < r) {
              const mid = (l + r) >> 1;
              if (priceRelArr[mid] < minPriceRel) l = mid + 1;
              else r = mid;
            }
            segStart = l;
            l = segStart;
            r = barOff + barCount;
            while (l < r) {
              const mid = (l + r) >> 1;
              if (priceRelArr[mid] <= maxPriceRel) l = mid + 1;
              else r = mid;
            }
            segEnd = l;
          }
          const len = segEnd - segStart;
          if (len <= 0) continue;
          sumCulled += len;
          if (segCount > 0 && this.residentCullSegStarts[segCount - 1] + this.residentCullSegCounts[segCount - 1] === segStart) {
            this.residentCullSegCounts[segCount - 1] += len;
          } else {
            if (segCount === this.residentCullSegStarts.length) {
              const nextStarts = new Int32Array(this.residentCullSegStarts.length * 2);
              const nextCounts = new Int32Array(this.residentCullSegCounts.length * 2);
              nextStarts.set(this.residentCullSegStarts);
              nextCounts.set(this.residentCullSegCounts);
              this.residentCullSegStarts = nextStarts;
              this.residentCullSegCounts = nextCounts;
            }
            this.residentCullSegStarts[segCount] = segStart;
            this.residentCullSegCounts[segCount] = len;
            segCount++;
          }
        }
        if (sumCulled === 0) return true;
        if (sumCulled < visibleCellCount * 0.5) {
          useVerticalSegments = true;
          culledTotalCells = sumCulled;
        }
      }

      const commandEncoder = this.device.createCommandEncoder({
        label: "WebGpuNativeResidentHeatmapCommandEncoder",
      });
      const passEncoder = commandEncoder.beginRenderPass({
        label: "WebGpuNativeResidentHeatmapRenderPass",
        colorAttachments: [
          {
            view: targetTexture.createView ? targetTexture.createView() : targetTexture,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      passEncoder.setScissorRect?.(scissorX, scissorY, scissorW, scissorH);
      passEncoder.setPipeline(this.residentRenderPipeline);
      passEncoder.setBindGroup(0, this.residentBindGroup);
      if (useVerticalSegments && culledTotalCells > 0) {
        for (let s = 0; s < segCount; s++) {
          passEncoder.draw(6, this.residentCullSegCounts[s], 0, this.residentCullSegStarts[s] - visibleCellOffset);
        }
      } else {
        passEncoder.draw(6, visibleCellCount, 0, 0);
      }
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
        throw error;
      }
      this.dispose();
      return false;
    }
  }

  private ensureStagingAndStorage(neededBytes: number): void {
    if (!this.stagingData || this.stagingData.byteLength < neededBytes) {
      let capBytes = Math.max(4096 * 4, this.stagingCapacityBytes);
      while (capBytes < neededBytes) capBytes *= 2;
      const oldBytes = this.stagingCapacityBytes;
      this.reserve(capBytes);
      this.stagingData = new Float32Array(capBytes / 4);
      this.stagingCapacityBytes = capBytes;
      this.releaseBytes(oldBytes);
    }

    if (neededBytes > this.cellCapacityBytes) {
      let nextCapBytes = Math.max(256 * HEATMAP_CELL_RECORD_BYTES, this.cellCapacityBytes);
      while (nextCapBytes < neededBytes) nextCapBytes *= 2;
      nextCapBytes = Math.min(Math.max(neededBytes, nextCapBytes), this.maxBufferSize);
      const oldBytes = this.cellCapacityBytes;
      this.reserve(nextCapBytes);
      const nextBuffer = this.device.createBuffer({
        label: "NativeHeatmapCellStorage",
        size: nextCapBytes,
        usage: 0x0080 | 0x0008, // STORAGE | COPY_DST
      });
      this.cellBuffer?.destroy?.();
      this.cellBuffer = nextBuffer;
      this.cellCapacityBytes = nextCapBytes;
      this.rebuildBindGroup();
      this.releaseBytes(oldBytes);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.uniformBuffer?.destroy?.();
      this.cellBuffer?.destroy?.();
      this.residentUniformBuffer?.destroy?.();
      this.residentCellBuffer?.destroy?.();
    } catch {
      // Mock safety
    }
    this.stagingData = null;
    this.stagingCapacityBytes = 0;
    this.uploadedData = null;
    this.uploadedDataReservedBytes = 0;
    this.uploadedCellCount = -1;
    this.uploadedDataKey = "";
    this.uploadedContentRevision = -1;
    this.uploadedMainRef = null;
    this.uploadedExtensionRef = null;
    this.uploadedMainCount = -1;
    this.uploadedExtensionCount = -1;
    this.hasUploadedUniform = false;
    this.cellCapacityBytes = 0;

    this.residentRenderPipeline = null;
    this.residentBindGroupLayout = null;
    this.residentUniformBuffer = null;
    this.residentBindGroup = null;
    this.residentCellBuffer = null;
    this.residentCellCapacityCells = 0;
    this.residentCellReservedBytes = 0;
    this.residentStagingRaw = null;
    this.residentStagingU32 = null;
    this.residentStagingF32 = null;
    this.residentStagingReservedBytes = 0;
    this.residentSyncedGeneration = -1;
    this.residentSyncedTailRevision = -1;
    this.residentSyncedLiveBarIndex = -2;
    this.residentSyncedBarCount = 0;
    this.residentTotalCells = 0;
    this.residentBarOffsets = new Int32Array(0);
    this.residentBarCounts = new Int32Array(0);
    this.residentBarSorted = new Uint8Array(0);
    this.residentCellPriceRel = null;
    this.residentCellPriceRelReservedBytes = 0;
    this.hasUploadedResidentUniform = false;

    this.releaseBytes(this.reservedBytes);
  }
}
