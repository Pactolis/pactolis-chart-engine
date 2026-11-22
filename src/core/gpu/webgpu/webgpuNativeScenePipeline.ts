import type { GpuNativeSceneInput } from "../gpuBackend.js";
import type { FootprintSeries } from "../../model/footprint.js";
import { incrementPerformanceCounter, recordPerformanceDuration } from "../../performanceTelemetry.js";

/** BarRecord: 8 x 32-bit words (32 bytes, 16-byte aligned). */
export const BAR_RECORD_WORDS = 8;
export const BAR_RECORD_BYTES = BAR_RECORD_WORDS * 4;

/** CellRecord: 4 x 32-bit words (16 bytes, 16-byte aligned). */
export const CELL_RECORD_WORDS = 4;
export const CELL_RECORD_BYTES = CELL_RECORD_WORDS * 4;

/** ViewUniform: 16 x 32-bit words (64 bytes, 16-byte aligned). */
export const VIEW_UNIFORM_WORDS = 16;
export const VIEW_UNIFORM_BYTES = VIEW_UNIFORM_WORDS * 4;

/** ComputeUniforms: 4 x 32-bit words (16 bytes, 16-byte aligned). */
export const COMPUTE_UNIFORM_WORDS = 4;
export const COMPUTE_UNIFORM_BYTES = COMPUTE_UNIFORM_WORDS * 4;

const TAIL_CELL_HEADROOM = 256;
const COMPUTE_WORKGROUP_SIZE = 64;

export const COMPUTE_STATS_WGSL = `
struct ComputeUniforms {
  dirtyStart: u32,
  dirtyCount: u32,
  _pad0: u32,
  _pad1: u32,
};

struct BarRecord {
  openRel: f32,
  highRel: f32,
  lowRel: f32,
  closeRel: f32,
  maxVol: f32,
  pocBinRel: f32,
  cellOffset: u32,
  cellCount: u32,
};

struct CellRecord {
  barIndex: u32,
  priceBinRel: f32,
  buyVol: f32,
  sellVol: f32,
};

@group(0) @binding(0) var<uniform> u_compute: ComputeUniforms;
@group(0) @binding(1) var<storage, read_write> bars: array<BarRecord>;
@group(0) @binding(2) var<storage, read> cells: array<CellRecord>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u_compute.dirtyCount) {
    return;
  }
  let barIndex = u_compute.dirtyStart + idx;
  let bar = bars[barIndex];
  var maxVol: f32 = 0.0;
  var pocBinRel: f32 = 0.0;
  let end = bar.cellOffset + bar.cellCount;
  for (var i: u32 = bar.cellOffset; i < end; i = i + 1u) {
    let cell = cells[i];
    let v = cell.buyVol + cell.sellVol;
    if (v > maxVol) {
      maxVol = v;
      pocBinRel = cell.priceBinRel;
    }
  }
  bars[barIndex].maxVol = maxVol;
  bars[barIndex].pocBinRel = pocBinRel;
}
`;

export const CANDLE_WGSL = `
struct ViewUniform {
  resolution: vec2<f32>,
  visibleFrom: u32,
  flags: u32,
  area: vec4<f32>,
  offsetX: f32,
  colWidth: f32,
  priceTopRel: f32,
  pricePerPx: f32,
  candleWidth: f32,
  priceStep: f32,
  candleStyle: u32,
  visibleCellOffset: u32,
};

struct BarRecord {
  openRel: f32,
  highRel: f32,
  lowRel: f32,
  closeRel: f32,
  maxVol: f32,
  pocBinRel: f32,
  cellOffset: u32,
  cellCount: u32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<storage, read> bars: array<BarRecord>;

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

fn y_of_price_rel(price_rel: f32) -> f32 {
  return u_view.area.y + (u_view.priceTopRel - price_rel) / u_view.pricePerPx;
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_idx: u32,
  @builtin(instance_index) instance_idx: u32,
) -> VertexOutput {
  var out: VertexOutput;
  if (u_view.candleStyle == 0u) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let bar_index = u_view.visibleFrom + instance_idx;
  let bar = bars[bar_index];
  let x_left = u_view.area.x + u_view.offsetX + f32(bar_index) * u_view.colWidth;

  let is_up = bar.closeRel >= bar.openRel;
  let color = select(
    vec4<f32>(1.0, 0.42, 0.45, 1.0),
    vec4<f32>(0.27, 0.86, 0.62, 1.0),
    is_up
  );

  let is_body = vertex_idx >= 6u;
  let unit = UNIT_QUAD[vertex_idx % 6u];

  var rx: f32;
  var ry: f32;
  var rw: f32;
  var rh: f32;

  if (u_view.candleStyle == 2u) {
    let cx = x_left + u_view.colWidth * 0.5;
    if (!is_body) {
      let y_high = y_of_price_rel(bar.highRel);
      let y_low = y_of_price_rel(bar.lowRel);
      rw = max(min(u_view.colWidth * 0.12, 3.0), 1.0);
      rx = cx - rw * 0.5;
      ry = y_high;
      rh = max(y_low - y_high, 1.0);
    } else {
      let y_open = y_of_price_rel(bar.openRel);
      let y_close = y_of_price_rel(bar.closeRel);
      rw = max(u_view.colWidth * 0.7, 1.0);
      rx = cx - rw * 0.5;
      ry = min(y_open, y_close);
      rh = max(abs(y_close - y_open), 1.0);
    }
  } else {
    let cx = x_left + u_view.candleWidth * 0.5;
    if (!is_body) {
      let y_high = y_of_price_rel(bar.highRel);
      let y_low = y_of_price_rel(bar.lowRel);
      rw = 1.0;
      rx = cx - 0.5;
      ry = y_high;
      rh = max(y_low - y_high, 1.0);
    } else {
      let y_open = y_of_price_rel(bar.openRel);
      let y_close = y_of_price_rel(bar.closeRel);
      rw = max(u_view.candleWidth - 3.0, 2.0);
      rx = cx - rw * 0.5;
      ry = min(y_open, y_close);
      rh = max(abs(y_close - y_open), 1.0);
    }
  }

  let pos = vec2<f32>(rx, ry) + unit * vec2<f32>(rw, rh);
  let clip_x = (pos.x / u_view.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_view.resolution.y) * 2.0;
  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  if (in.color.a <= 0.0) {
    discard;
  }
  return in.color;
}
`;

export const FOOTPRINT_CELL_WGSL = `
struct ViewUniform {
  resolution: vec2<f32>,
  visibleFrom: u32,
  flags: u32,
  area: vec4<f32>,
  offsetX: f32,
  colWidth: f32,
  priceTopRel: f32,
  pricePerPx: f32,
  candleWidth: f32,
  priceStep: f32,
  candleStyle: u32,
  visibleCellOffset: u32,
};

struct BarRecord {
  openRel: f32,
  highRel: f32,
  lowRel: f32,
  closeRel: f32,
  maxVol: f32,
  pocBinRel: f32,
  cellOffset: u32,
  cellCount: u32,
};

struct CellRecord {
  barIndex: u32,
  priceBinRel: f32,
  buyVol: f32,
  sellVol: f32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<storage, read> bars: array<BarRecord>;
@group(0) @binding(2) var<storage, read> cells: array<CellRecord>;

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

fn degenerate_out() -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  return out;
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertex_idx: u32,
  @builtin(instance_index) instance_idx: u32,
) -> VertexOutput {
  let cell = cells[u_view.visibleCellOffset + instance_idx];
  let bar = bars[cell.barIndex];
  if (bar.maxVol <= 0.0) {
    return degenerate_out();
  }

  let x_left = u_view.area.x + u_view.offsetX + f32(cell.barIndex) * u_view.colWidth;
  if (x_left + u_view.colWidth < u_view.area.x || x_left > u_view.area.x + u_view.area.z) {
    return degenerate_out();
  }

  var low_p = max(cell.priceBinRel, bar.lowRel);
  var high_p = min(cell.priceBinRel + u_view.priceStep, bar.highRel);
  if (!(high_p > low_p)) {
    if (!(cell.priceBinRel <= bar.highRel && cell.priceBinRel + u_view.priceStep > bar.lowRel)) {
      return degenerate_out();
    }
    low_p = cell.priceBinRel;
    high_p = cell.priceBinRel + u_view.priceStep;
  }

  let y_high = u_view.area.y + (u_view.priceTopRel - high_p) / u_view.pricePerPx;
  let y_low = u_view.area.y + (u_view.priceTopRel - low_p) / u_view.pricePerPx;
  let y_top = min(y_high, y_low);
  let h = abs(y_low - y_high);
  if (!(h > 0.0)) {
    return degenerate_out();
  }
  if (y_top > u_view.area.y + u_view.area.w || y_top + h < u_view.area.y) {
    return degenerate_out();
  }

  let fp_left = x_left + u_view.candleWidth;
  let fp_w = u_view.colWidth - u_view.candleWidth;
  let half_w = fp_w * 0.5;
  let sub_quad = vertex_idx / 6u;
  let unit = UNIT_QUAD[vertex_idx % 6u];

  var rx: f32;
  var ry: f32 = y_top;
  var rw: f32;
  var rh: f32;
  var color: vec4<f32>;

  let draw_heat = (u_view.flags & 1u) != 0u;
  let draw_poc = (u_view.flags & 2u) != 0u;

  if (sub_quad == 0u) {
    if (!draw_poc || cell.priceBinRel != bar.pocBinRel) {
      return degenerate_out();
    }
    rx = fp_left;
    rw = fp_w;
    rh = h;
    color = vec4<f32>(1.0, 0.78, 0.2, 0.18);
  } else {
    if (!draw_heat) {
      return degenerate_out();
    }
    let row_h = select(h, h - 1.0, h > 1.0);
    rh = row_h;
    if (sub_quad == 1u) {
      rx = fp_left;
      rw = half_w;
      let sell_a = 0.12 + 0.7 * (cell.sellVol / bar.maxVol);
      color = vec4<f32>(0.85, 0.25, 0.3, sell_a);
    } else {
      rx = fp_left + half_w;
      rw = half_w;
      let buy_a = 0.12 + 0.7 * (cell.buyVol / bar.maxVol);
      color = vec4<f32>(0.13, 0.62, 0.45, buy_a);
    }
  }

  let pos = vec2<f32>(rx, ry) + unit * vec2<f32>(rw, rh);
  let clip_x = (pos.x / u_view.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_view.resolution.y) * 2.0;
  var out: VertexOutput;
  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  if (in.color.a <= 0.0) {
    discard;
  }
  return in.color;
}
`;

export interface WebGpuNativeScenePipelineOptions {
  readonly supportsTimestampQuery?: boolean;
  readonly maxBufferSize?: number;
}

export interface PreparedNativeFrame {
  readonly ok: boolean;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly visibleCellOffset: number;
  readonly visibleCellCount: number;
}

interface TimestampSlot {
  state: "idle" | "mapping";
  resolveBuffer: any;
  readBuffer: any;
}

export class WebGpuNativeScenePipeline {
  readonly computePipeline: any;
  readonly candlePipeline: any;
  readonly footprintPipeline: any;
  readonly viewUniformBuffer: any;
  readonly computeUniformBuffer: any;
  private readonly computeBindGroupLayout: any;
  private readonly renderBindGroupLayout: any;
  private computeBindGroup: any = null;
  private renderBindGroup: any = null;
  private barBuffer: any;
  private cellBuffer: any;
  private barCapacity = 0;
  private cellCapacity = 0;

  private barStagingBuffer = new ArrayBuffer(64 * BAR_RECORD_BYTES);
  private barStagingF32 = new Float32Array(this.barStagingBuffer);
  private barStagingU32 = new Uint32Array(this.barStagingBuffer);

  private cellStagingBuffer = new ArrayBuffer(256 * CELL_RECORD_BYTES);
  private cellStagingF32 = new Float32Array(this.cellStagingBuffer);
  private cellStagingU32 = new Uint32Array(this.cellStagingBuffer);

  private readonly tailBarBuffer = new ArrayBuffer(BAR_RECORD_BYTES);
  private readonly tailBarF32 = new Float32Array(this.tailBarBuffer);
  private readonly tailBarU32 = new Uint32Array(this.tailBarBuffer);

  private readonly viewUniformRaw = new ArrayBuffer(VIEW_UNIFORM_BYTES);
  private readonly viewUniformF32 = new Float32Array(this.viewUniformRaw);
  private readonly viewUniformU32 = new Uint32Array(this.viewUniformRaw);

  private readonly computeUniformRaw = new ArrayBuffer(COMPUTE_UNIFORM_BYTES);
  private readonly computeUniformU32 = new Uint32Array(this.computeUniformRaw);

  private barCellOffsets = new Uint32Array(64);
  private barCellCounts = new Uint32Array(64);

  private syncedSeries: FootprintSeries | null = null;
  private syncedResetEpoch = -1;
  private syncedNonTailRevision = -1;
  private syncedRevision = -1;
  private syncedBarCount = -1;
  private syncedTailCellRevision = -1;
  private syncedTailOpen = Number.NaN;
  private syncedTailHigh = Number.NaN;
  private syncedTailLow = Number.NaN;
  private syncedTailClose = Number.NaN;
  private syncedTailCellCount = -1;
  private tailCellOffset = 0;

  private activeBarCount = 0;
  private activeCellCount = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  private priceOriginValue = 0;

  private readonly maxBufferSize: number;
  private readonly querySet: any = null;
  private readonly timestampSlots: TimestampSlot[] = [];
  private disposed = false;

  constructor(
    private readonly device: any,
    public readonly format: string,
    options?: WebGpuNativeScenePipelineOptions,
  ) {
    this.maxBufferSize = options?.maxBufferSize ?? device.limits?.maxBufferSize ?? 268435456;

    const blend = {
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
    };

    const computeShader = device.createShaderModule({
      label: "NativeSceneComputeStatsShader",
      code: COMPUTE_STATS_WGSL,
    });
    const candleShader = device.createShaderModule({
      label: "NativeSceneCandleShader",
      code: CANDLE_WGSL,
    });
    const footprintShader = device.createShaderModule({
      label: "NativeSceneFootprintCellShader",
      code: FOOTPRINT_CELL_WGSL,
    });

    this.viewUniformBuffer = device.createBuffer({
      label: "NativeSceneViewUniform",
      size: VIEW_UNIFORM_BYTES,
      usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
    });
    this.computeUniformBuffer = device.createBuffer({
      label: "NativeSceneComputeUniform",
      size: COMPUTE_UNIFORM_BYTES,
      usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
    });

    this.computeBindGroupLayout = device.createBindGroupLayout({
      label: "NativeSceneComputeBindGroupLayout",
      entries: [
        { binding: 0, visibility: 0x4, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x4, buffer: { type: "storage" } },
        { binding: 2, visibility: 0x4, buffer: { type: "read-only-storage" } },
      ],
    });
    this.renderBindGroupLayout = device.createBindGroupLayout({
      label: "NativeSceneRenderBindGroupLayout",
      entries: [
        { binding: 0, visibility: 0x1, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x1, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: 0x1, buffer: { type: "read-only-storage" } },
      ],
    });

    const computePipelineLayout = device.createPipelineLayout({
      label: "NativeSceneComputePipelineLayout",
      bindGroupLayouts: [this.computeBindGroupLayout],
    });
    const renderPipelineLayout = device.createPipelineLayout({
      label: "NativeSceneRenderPipelineLayout",
      bindGroupLayouts: [this.renderBindGroupLayout],
    });

    this.computePipeline = device.createComputePipeline({
      label: "NativeSceneComputeStatsPipeline",
      layout: computePipelineLayout,
      compute: {
        module: computeShader,
        entryPoint: "cs_main",
      },
    });

    this.candlePipeline = device.createRenderPipeline({
      label: "NativeSceneCandlePipeline",
      layout: renderPipelineLayout,
      vertex: {
        module: candleShader,
        entryPoint: "vs_main",
      },
      fragment: {
        module: candleShader,
        entryPoint: "fs_main",
        targets: [{ format, blend }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.footprintPipeline = device.createRenderPipeline({
      label: "NativeSceneFootprintPipeline",
      layout: renderPipelineLayout,
      vertex: {
        module: footprintShader,
        entryPoint: "vs_main",
      },
      fragment: {
        module: footprintShader,
        entryPoint: "fs_main",
        targets: [{ format, blend }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.barCapacity = 64;
    this.cellCapacity = 1024;
    this.barBuffer = this.allocateStorageBuffer("NativeSceneBarStorage", this.barCapacity * BAR_RECORD_BYTES);
    this.cellBuffer = this.allocateStorageBuffer("NativeSceneCellStorage", this.cellCapacity * CELL_RECORD_BYTES);
    this.rebuildBindGroups();

    const tsEnabled = Boolean(
      (options?.supportsTimestampQuery ?? device.features?.has?.("timestamp-query"))
      && typeof device.createQuerySet === "function",
    );
    if (tsEnabled) {
      try {
        this.querySet = device.createQuerySet({
          label: "NativeSceneTimestampQuerySet",
          type: "timestamp",
          count: 4, // 2 slots x (begin, end)
        });
        for (let slot = 0; slot < 2; slot++) {
          const resolveBuffer = device.createBuffer({
            label: `NativeSceneTimestampResolve${slot}`,
            size: 16,
            usage: 0x0200 | 0x0004, // QUERY_RESOLVE | COPY_SRC
          });
          const readBuffer = device.createBuffer({
            label: `NativeSceneTimestampRead${slot}`,
            size: 16,
            usage: 0x0008 | 0x0001, // COPY_DST | MAP_READ
          });
          this.timestampSlots.push({ state: "idle", resolveBuffer, readBuffer });
        }
      } catch {
        try { this.querySet?.destroy?.(); } catch {}
        this.querySet = null;
        for (const slot of this.timestampSlots) {
          try { slot.resolveBuffer?.destroy?.(); } catch {}
          try { slot.readBuffer?.destroy?.(); } catch {}
        }
        this.timestampSlots.length = 0;
      }
    }
  }

  get priceOrigin(): number {
    return this.priceOriginValue;
  }

  get syncedCounts(): { bars: number; cells: number } {
    return { bars: this.activeBarCount, cells: this.activeCellCount };
  }

  private allocateStorageBuffer(label: string, size: number): any {
    return this.device.createBuffer({
      label,
      size: Math.max(16, size),
      usage: 0x0080 | 0x0008, // GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
  }

  private rebuildBindGroups(): void {
    this.computeBindGroup = this.device.createBindGroup({
      label: "NativeSceneComputeBindGroup",
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.computeUniformBuffer } },
        { binding: 1, resource: { buffer: this.barBuffer } },
        { binding: 2, resource: { buffer: this.cellBuffer } },
      ],
    });
    this.renderBindGroup = this.device.createBindGroup({
      label: "NativeSceneRenderBindGroup",
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.viewUniformBuffer } },
        { binding: 1, resource: { buffer: this.barBuffer } },
        { binding: 2, resource: { buffer: this.cellBuffer } },
      ],
    });
  }

  private ensureStagingCapacity(barCount: number, cellCount: number): void {
    if (barCount * BAR_RECORD_BYTES > this.barStagingBuffer.byteLength) {
      let cap = Math.max(64, this.barStagingBuffer.byteLength / BAR_RECORD_BYTES);
      while (cap < barCount) cap *= 2;
      this.barStagingBuffer = new ArrayBuffer(cap * BAR_RECORD_BYTES);
      this.barStagingF32 = new Float32Array(this.barStagingBuffer);
      this.barStagingU32 = new Uint32Array(this.barStagingBuffer);
    }
    if (barCount > this.barCellOffsets.length) {
      let cap = Math.max(64, this.barCellOffsets.length);
      while (cap < barCount) cap *= 2;
      this.barCellOffsets = new Uint32Array(cap);
      this.barCellCounts = new Uint32Array(cap);
    }
    if (cellCount * CELL_RECORD_BYTES > this.cellStagingBuffer.byteLength) {
      let cap = Math.max(256, this.cellStagingBuffer.byteLength / CELL_RECORD_BYTES);
      while (cap < cellCount) cap *= 2;
      this.cellStagingBuffer = new ArrayBuffer(cap * CELL_RECORD_BYTES);
      this.cellStagingF32 = new Float32Array(this.cellStagingBuffer);
      this.cellStagingU32 = new Uint32Array(this.cellStagingBuffer);
    }
  }

  private ensureStorageCapacity(barCount: number, cellCountWithHeadroom: number): boolean {
    const neededBarBytes = Math.max(1, barCount) * BAR_RECORD_BYTES;
    const neededCellBytes = Math.max(1, cellCountWithHeadroom) * CELL_RECORD_BYTES;
    if (neededBarBytes > this.maxBufferSize || neededCellBytes > this.maxBufferSize) {
      return false;
    }

    let reallocated = false;
    if (barCount > this.barCapacity) {
      let nextCap = Math.max(64, this.barCapacity);
      while (nextCap < barCount) nextCap *= 2;
      const maxBars = Math.floor(this.maxBufferSize / BAR_RECORD_BYTES);
      nextCap = Math.min(Math.max(barCount, nextCap), maxBars);
      this.barBuffer?.destroy?.();
      this.barCapacity = nextCap;
      this.barBuffer = this.allocateStorageBuffer("NativeSceneBarStorage", nextCap * BAR_RECORD_BYTES);
      reallocated = true;
    }

    if (cellCountWithHeadroom > this.cellCapacity) {
      let nextCap = Math.max(TAIL_CELL_HEADROOM, this.cellCapacity);
      while (nextCap < cellCountWithHeadroom) nextCap *= 2;
      const maxCells = Math.floor(this.maxBufferSize / CELL_RECORD_BYTES);
      nextCap = Math.min(Math.max(cellCountWithHeadroom, nextCap), maxCells);
      this.cellBuffer?.destroy?.();
      this.cellCapacity = nextCap;
      this.cellBuffer = this.allocateStorageBuffer("NativeSceneCellStorage", nextCap * CELL_RECORD_BYTES);
      reallocated = true;
    }

    if (reallocated) {
      this.rebuildBindGroups();
    }
    return true;
  }

  private writeStorageBuffer(buffer: any, dstByteOffset: number, src: ArrayBuffer, srcByteLength: number): void {
    if (srcByteLength <= 0) return;
    this.device.queue.writeBuffer(buffer, dstByteOffset, src, 0, srcByteLength);
  }

  private syncSeries(series: FootprintSeries): boolean {
    const barCount = series.length;
    this.dirtyStart = 0;
    this.dirtyCount = 0;

    if (barCount === 0) {
      this.syncedSeries = series;
      this.syncedResetEpoch = series.resetEpoch;
      this.syncedNonTailRevision = series.nonTailRevision;
      this.syncedRevision = series.revision;
      this.syncedBarCount = 0;
      this.syncedTailCellRevision = -1;
      this.syncedTailOpen = Number.NaN;
      this.syncedTailHigh = Number.NaN;
      this.syncedTailLow = Number.NaN;
      this.syncedTailClose = Number.NaN;
      this.syncedTailCellCount = -1;
      this.tailCellOffset = 0;
      this.activeBarCount = 0;
      this.activeCellCount = 0;
      return true;
    }

    const sameStructure =
      this.syncedSeries === series
      && this.syncedResetEpoch === series.resetEpoch
      && this.syncedNonTailRevision === series.nonTailRevision
      && this.syncedBarCount === barCount;

    if (sameStructure) {
      if (this.syncedRevision === series.revision) {
        return true;
      }

      const tailIdx = barCount - 1;
      const tailBar = series.at(tailIdx);
      if (tailBar) {
        const tailCellRev = tailBar.cellRevision ?? 0;
        const tailCellsSize = tailBar.cells.size;
        const tailUnchanged =
          this.syncedTailCellRevision === tailCellRev
          && this.syncedTailOpen === tailBar.open
          && this.syncedTailHigh === tailBar.high
          && this.syncedTailLow === tailBar.low
          && this.syncedTailClose === tailBar.close
          && this.syncedTailCellCount === tailCellsSize;

        if (tailUnchanged) {
          this.syncedRevision = series.revision;
          return true;
        }

        if (this.tailCellOffset + tailCellsSize <= this.cellCapacity) {
          this.ensureStagingCapacity(barCount, tailCellsSize);
          const origin = this.priceOriginValue;
          this.tailBarF32[0] = tailBar.open - origin;
          this.tailBarF32[1] = tailBar.high - origin;
          this.tailBarF32[2] = tailBar.low - origin;
          this.tailBarF32[3] = tailBar.close - origin;
          this.tailBarF32[4] = 0;
          this.tailBarF32[5] = 0;
          this.tailBarU32[6] = this.tailCellOffset;
          this.tailBarU32[7] = tailCellsSize;

          let cellWord = 0;
          for (const cell of tailBar.cells.values()) {
            this.cellStagingU32[cellWord] = tailIdx;
            this.cellStagingF32[cellWord + 1] = cell.priceBin - origin;
            this.cellStagingF32[cellWord + 2] = cell.buyVol;
            this.cellStagingF32[cellWord + 3] = cell.sellVol;
            cellWord += CELL_RECORD_WORDS;
          }

          this.writeStorageBuffer(
            this.barBuffer,
            tailIdx * BAR_RECORD_BYTES,
            this.tailBarBuffer,
            BAR_RECORD_BYTES,
          );
          if (tailCellsSize > 0) {
            this.writeStorageBuffer(
              this.cellBuffer,
              this.tailCellOffset * CELL_RECORD_BYTES,
              this.cellStagingBuffer,
              tailCellsSize * CELL_RECORD_BYTES,
            );
          }

          const dataBytes = BAR_RECORD_BYTES + tailCellsSize * CELL_RECORD_BYTES;
          incrementPerformanceCounter("gpu.upload.bytes", dataBytes);
          incrementPerformanceCounter("gpu.native.upload.dataBytes", dataBytes);

          this.barCellOffsets[tailIdx] = this.tailCellOffset;
          this.barCellCounts[tailIdx] = tailCellsSize;
          this.activeCellCount = this.tailCellOffset + tailCellsSize;
          this.syncedRevision = series.revision;
          this.syncedTailCellRevision = tailCellRev;
          this.syncedTailOpen = tailBar.open;
          this.syncedTailHigh = tailBar.high;
          this.syncedTailLow = tailBar.low;
          this.syncedTailClose = tailBar.close;
          this.syncedTailCellCount = tailCellsSize;
          this.dirtyStart = tailIdx;
          this.dirtyCount = 1;
          return true;
        }
      }
    }

    // Full rebuild path (initial load, resetEpoch, nonTailRevision, shrink, or capacity overflow).
    let totalCells = 0;
    for (let i = 0; i < barCount; i++) {
      const bar = series.at(i);
      if (bar) totalCells += bar.cells.size;
    }

    const firstLow = series.at(0)?.low ?? 0;
    const origin = Number.isFinite(firstLow) ? firstLow : 0;

    if (!this.ensureStorageCapacity(barCount, totalCells + TAIL_CELL_HEADROOM)) {
      return false;
    }
    this.ensureStagingCapacity(barCount, totalCells);

    let cellCursor = 0;
    for (let i = 0; i < barCount; i++) {
      const bar = series.at(i);
      const barBase = i * BAR_RECORD_WORDS;
      if (!bar) {
        this.barStagingF32[barBase] = 0;
        this.barStagingF32[barBase + 1] = 0;
        this.barStagingF32[barBase + 2] = 0;
        this.barStagingF32[barBase + 3] = 0;
        this.barStagingF32[barBase + 4] = 0;
        this.barStagingF32[barBase + 5] = 0;
        this.barStagingU32[barBase + 6] = cellCursor;
        this.barStagingU32[barBase + 7] = 0;
        this.barCellOffsets[i] = cellCursor;
        this.barCellCounts[i] = 0;
        continue;
      }

      const cellCount = bar.cells.size;
      const cellOffset = cellCursor;
      this.barStagingF32[barBase] = bar.open - origin;
      this.barStagingF32[barBase + 1] = bar.high - origin;
      this.barStagingF32[barBase + 2] = bar.low - origin;
      this.barStagingF32[barBase + 3] = bar.close - origin;
      this.barStagingF32[barBase + 4] = 0;
      this.barStagingF32[barBase + 5] = 0;
      this.barStagingU32[barBase + 6] = cellOffset;
      this.barStagingU32[barBase + 7] = cellCount;
      this.barCellOffsets[i] = cellOffset;
      this.barCellCounts[i] = cellCount;

      for (const cell of bar.cells.values()) {
        const cellBase = cellCursor * CELL_RECORD_WORDS;
        this.cellStagingU32[cellBase] = i;
        this.cellStagingF32[cellBase + 1] = cell.priceBin - origin;
        this.cellStagingF32[cellBase + 2] = cell.buyVol;
        this.cellStagingF32[cellBase + 3] = cell.sellVol;
        cellCursor++;
      }
    }

    const barBytes = barCount * BAR_RECORD_BYTES;
    const cellBytes = totalCells * CELL_RECORD_BYTES;
    this.writeStorageBuffer(this.barBuffer, 0, this.barStagingBuffer, barBytes);
    if (cellBytes > 0) {
      this.writeStorageBuffer(this.cellBuffer, 0, this.cellStagingBuffer, cellBytes);
    }

    const dataBytes = barBytes + cellBytes;
    incrementPerformanceCounter("gpu.upload.bytes", dataBytes);
    incrementPerformanceCounter("gpu.native.upload.dataBytes", dataBytes);

    const lastBar = series.at(barCount - 1);
    this.priceOriginValue = origin;
    this.syncedSeries = series;
    this.syncedResetEpoch = series.resetEpoch;
    this.syncedNonTailRevision = series.nonTailRevision;
    this.syncedRevision = series.revision;
    this.syncedBarCount = barCount;
    this.activeBarCount = barCount;
    this.activeCellCount = totalCells;
    this.tailCellOffset = this.barCellOffsets[barCount - 1] ?? 0;
    this.syncedTailCellRevision = lastBar?.cellRevision ?? 0;
    this.syncedTailOpen = lastBar?.open ?? Number.NaN;
    this.syncedTailHigh = lastBar?.high ?? Number.NaN;
    this.syncedTailLow = lastBar?.low ?? Number.NaN;
    this.syncedTailClose = lastBar?.close ?? Number.NaN;
    this.syncedTailCellCount = lastBar?.cells.size ?? 0;
    this.dirtyStart = 0;
    this.dirtyCount = barCount;
    return true;
  }

  prepareFrame(scene: GpuNativeSceneInput, logicalWidth: number, logicalHeight: number): PreparedNativeFrame {
    if (this.disposed) {
      return { ok: false, visibleFrom: 0, visibleTo: 0, visibleCellOffset: 0, visibleCellCount: 0 };
    }

    if (!this.syncSeries(scene.series)) {
      return { ok: false, visibleFrom: 0, visibleTo: 0, visibleCellOffset: 0, visibleCellCount: 0 };
    }

    if (this.dirtyCount > 0) {
      this.computeUniformU32[0] = this.dirtyStart;
      this.computeUniformU32[1] = this.dirtyCount;
      this.computeUniformU32[2] = 0;
      this.computeUniformU32[3] = 0;
      this.writeStorageBuffer(this.computeUniformBuffer, 0, this.computeUniformRaw, COMPUTE_UNIFORM_BYTES);
      incrementPerformanceCounter("gpu.upload.bytes", COMPUTE_UNIFORM_BYTES);
      incrementPerformanceCounter("gpu.native.upload.uniformBytes", COMPUTE_UNIFORM_BYTES);
    }

    const { area, offsetX, colWidth, priceTop, pricePerPx, candleWidth } = scene.view;
    const safeColWidth = colWidth > 0 ? colWidth : 1;
    const barCount = this.activeBarCount;
    const visibleFrom = barCount > 0
      ? Math.max(0, Math.floor(-offsetX / safeColWidth))
      : 0;
    const visibleTo = barCount > 0
      ? Math.min(barCount, Math.ceil((area.width - offsetX) / safeColWidth) + 1)
      : 0;

    let visibleCellOffset = 0;
    let visibleCellCount = 0;
    if (visibleTo > visibleFrom && barCount > 0) {
      visibleCellOffset = this.barCellOffsets[visibleFrom];
      const lastIdx = visibleTo - 1;
      const lastEnd = this.barCellOffsets[lastIdx] + this.barCellCounts[lastIdx];
      visibleCellCount = Math.max(0, lastEnd - visibleCellOffset);
    }

    const flags = (scene.drawHeat ? 1 : 0) | (scene.drawPoc ? 2 : 0);
    const candleStyle = scene.candleStyle === "full" ? 2 : scene.candleStyle === "strip" ? 1 : 0;

    this.viewUniformF32[0] = logicalWidth > 0 ? logicalWidth : 1;
    this.viewUniformF32[1] = logicalHeight > 0 ? logicalHeight : 1;
    this.viewUniformU32[2] = visibleFrom;
    this.viewUniformU32[3] = flags;
    this.viewUniformF32[4] = area.left;
    this.viewUniformF32[5] = area.top;
    this.viewUniformF32[6] = area.width;
    this.viewUniformF32[7] = area.height;
    this.viewUniformF32[8] = offsetX;
    this.viewUniformF32[9] = colWidth;
    this.viewUniformF32[10] = priceTop - this.priceOriginValue;
    this.viewUniformF32[11] = pricePerPx;
    this.viewUniformF32[12] = candleWidth;
    this.viewUniformF32[13] = scene.series.config.priceStep;
    this.viewUniformU32[14] = candleStyle;
    this.viewUniformU32[15] = visibleCellOffset;

    this.writeStorageBuffer(this.viewUniformBuffer, 0, this.viewUniformRaw, VIEW_UNIFORM_BYTES);
    incrementPerformanceCounter("gpu.upload.bytes", VIEW_UNIFORM_BYTES);
    incrementPerformanceCounter("gpu.native.upload.uniformBytes", VIEW_UNIFORM_BYTES);

    return { ok: true, visibleFrom, visibleTo, visibleCellOffset, visibleCellCount };
  }

  needsComputeDispatch(): boolean {
    return !this.disposed && this.dirtyCount > 0;
  }

  recordComputePass(commandEncoder: any): void {
    if (this.disposed || this.dirtyCount <= 0) return;
    const pass = commandEncoder.beginComputePass({ label: "NativeSceneComputeStatsPass" });
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.dirtyCount / COMPUTE_WORKGROUP_SIZE));
    pass.end();
  }

  recordRenderPasses(passEncoder: any, scene: GpuNativeSceneInput, prepared: PreparedNativeFrame): void {
    if (this.disposed || prepared.visibleTo <= prepared.visibleFrom) return;
    const visibleBarCount = prepared.visibleTo - prepared.visibleFrom;

    if (scene.drawCandles && scene.candleStyle !== "none" && visibleBarCount > 0) {
      passEncoder.setPipeline(this.candlePipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(12, visibleBarCount, 0, 0);
    }

    if (scene.drawFootprint && (scene.drawHeat || scene.drawPoc) && prepared.visibleCellCount > 0) {
      passEncoder.setPipeline(this.footprintPipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(18, prepared.visibleCellCount, 0, 0);
    }
  }

  beginTimestampPass(): number | null {
    if (this.disposed || !this.querySet || this.timestampSlots.length === 0) return null;
    for (let i = 0; i < this.timestampSlots.length; i++) {
      if (this.timestampSlots[i].state === "idle") {
        return i;
      }
    }
    return null;
  }

  timestampWritesFor(slot: number): { querySet: any; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number } {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: slot * 2,
      endOfPassWriteIndex: slot * 2 + 1,
    };
  }

  resolveTimestampPass(commandEncoder: any, slotIndex: number): void {
    const slot = this.timestampSlots[slotIndex];
    if (!slot || !this.querySet) return;
    if (typeof commandEncoder.resolveQuerySet !== "function" || typeof commandEncoder.copyBufferToBuffer !== "function") {
      return;
    }
    commandEncoder.resolveQuerySet(this.querySet, slotIndex * 2, 2, slot.resolveBuffer, 0);
    commandEncoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, 16);
  }

  readbackTimestampPass(slotIndex: number): void {
    const slot = this.timestampSlots[slotIndex];
    if (!slot || slot.state !== "idle" || typeof slot.readBuffer?.mapAsync !== "function") return;
    slot.state = "mapping";
    Promise.resolve(slot.readBuffer.mapAsync(0x0001))
      .then(() => {
        if (this.disposed) {
          try { slot.readBuffer.unmap?.(); } catch {}
          slot.state = "idle";
          return;
        }
        try {
          const range = slot.readBuffer.getMappedRange();
          const values = new BigInt64Array(range);
          const deltaNs = Number(values[1] - values[0]);
          if (Number.isFinite(deltaNs) && deltaNs >= 0) {
            recordPerformanceDuration("chart.gpu.timestamp.ms", deltaNs / 1_000_000);
          }
        } finally {
          try { slot.readBuffer.unmap?.(); } catch {}
          slot.state = "idle";
        }
      })
      .catch(() => {
        slot.state = "idle";
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncedSeries = null;
    try {
      this.viewUniformBuffer?.destroy?.();
      this.computeUniformBuffer?.destroy?.();
      this.barBuffer?.destroy?.();
      this.cellBuffer?.destroy?.();
      this.querySet?.destroy?.();
      for (const slot of this.timestampSlots) {
        slot.resolveBuffer?.destroy?.();
        slot.readBuffer?.destroy?.();
      }
    } catch {
      // Mock safety
    }
    this.timestampSlots.length = 0;
  }
}
