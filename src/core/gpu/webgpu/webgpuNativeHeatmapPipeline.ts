import type { GpuNativeHeatmapFrame, GpuNativeHeatmapPlot, GpuNativeHeatmapRect } from "../gpuBackend.js";
import {
  incrementPerformanceCounter,
  isPerformanceTelemetryEnabled,
  recordPerformanceDuration,
} from "../../performanceTelemetry.js";

/** HeatmapCellRecord: 8 x 32-bit floats (32 bytes, 16-byte aligned). */
export const HEATMAP_CELL_RECORD_WORDS = 8;
export const HEATMAP_CELL_RECORD_BYTES = HEATMAP_CELL_RECORD_WORDS * 4;

/** HeatmapUniform: 16 x 32-bit words (64 bytes, 16-byte aligned). */
export const HEATMAP_UNIFORM_WORDS = 16;
export const HEATMAP_UNIFORM_BYTES = HEATMAP_UNIFORM_WORDS * 4;

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
  pad0: f32,
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
  if (k <= 0.40) {
    t = k / 0.40;
    c0 = vec3<f32>(18.0, 38.0, 84.0);
    c1 = vec3<f32>(24.0, 112.0, 168.0);
    a0 = 0.22;
    a1 = 0.36;
  } else if (k <= 0.75) {
    t = (k - 0.40) / 0.35;
    c0 = vec3<f32>(24.0, 112.0, 168.0);
    c1 = vec3<f32>(34.0, 211.0, 238.0);
    a0 = 0.36;
    a1 = 0.54;
  } else {
    t = (k - 0.75) / 0.25;
    c0 = vec3<f32>(34.0, 211.0, 238.0);
    c1 = vec3<f32>(254.0, 240.0, 178.0);
    a0 = 0.54;
    a1 = 0.68;
  }

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

  private readonly uniformRaw = new ArrayBuffer(HEATMAP_UNIFORM_BYTES);
  private readonly uniformF32 = new Float32Array(this.uniformRaw);
  private readonly uniformU32 = new Uint32Array(this.uniformRaw);
  private readonly uploadedUniformU32 = new Uint32Array(HEATMAP_UNIFORM_WORDS);
  private hasUploadedUniform = false;

  private reservedBytes = 0;
  private preparedLeaseBytes = 0;
  private readonly maxBufferSize: number;
  private disposed = false;

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
      let needsDataUpload =
        !uploaded
        || this.uploadedDataKey !== frame.dataKey
        || this.uploadedCellCount !== cells
        || uploaded.length !== activeView.length;
      if (!needsDataUpload && uploaded) {
        for (let i = 0; i < activeView.length; i++) {
          if (uploaded[i] !== activeView[i]) {
            needsDataUpload = true;
            break;
          }
        }
      }

      if (needsDataUpload) {
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
      this.uniformF32[11] = 0;
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
    } catch {
      // Mock safety
    }
    this.stagingData = null;
    this.stagingCapacityBytes = 0;
    this.uploadedData = null;
    this.uploadedDataReservedBytes = 0;
    this.uploadedCellCount = -1;
    this.uploadedDataKey = "";
    this.hasUploadedUniform = false;
    this.cellCapacityBytes = 0;
    this.releaseBytes(this.reservedBytes);
  }
}
