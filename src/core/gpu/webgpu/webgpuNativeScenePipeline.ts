import type { GpuNativeSceneInput, GpuNativeSceneLodMode } from "../gpuBackend.js";
import type { FootprintSeries } from "../../model/footprint.js";
import type { FootprintBar } from "../../types.js";
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

/** PixelBucketRecord: 8 x 32-bit words (32 bytes, 16-byte aligned). */
export const PIXEL_BUCKET_RECORD_BYTES = 32;
/** MergedRowRecord: 4 x 32-bit words (16 bytes, 16-byte aligned). */
export const MERGED_ROW_RECORD_BYTES = 16;
/** Hard 4 MiB cap on sub-pixel merged row storage (falls back to immediate-quads above cap). */
export const MERGED_ROW_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
/** LodUniforms: 8 x 32-bit words (32 bytes, 16-byte aligned). */
export const LOD_UNIFORM_WORDS = 8;
export const LOD_UNIFORM_BYTES = LOD_UNIFORM_WORDS * 4;
/** AutoscaleUniforms & AutoscaleResult: 4 x 32-bit words (16 bytes, 16-byte aligned). */
export const AUTOSCALE_UNIFORM_WORDS = 4;
export const AUTOSCALE_UNIFORM_BYTES = AUTOSCALE_UNIFORM_WORDS * 4;
export const AUTOSCALE_RESULT_BYTES = 16;

export const TAIL_BAR_HEADROOM = 64;
export const TAIL_CELL_HEADROOM = 2048;
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

export const COMPUTE_PIXEL_BUCKET_WGSL = `
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

struct LodUniform {
  count: u32,
  startCoord: i32,
  plotHeight: u32,
  frameGen: u32,
  visibleTo: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
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

struct PixelBucketRecord {
  openRel: f32,
  highRel: f32,
  lowRel: f32,
  closeRel: f32,
  px: f32,
  valid: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<uniform> u_lod: LodUniform;
@group(0) @binding(2) var<storage, read> bars: array<BarRecord>;
@group(0) @binding(3) var<storage, read_write> buckets: array<PixelBucketRecord>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u_lod.count) {
    return;
  }
  let px = u_lod.startCoord + i32(idx);
  let origin_x = u_view.area.x + u_view.offsetX;
  let col_w = max(u_view.colWidth, 1e-6);

  let raw_start = (f32(px) - origin_x) / col_w;
  let raw_end = (f32(px + 1) - origin_x) / col_w;
  let vis_from = i32(u_view.visibleFrom);
  let vis_to = i32(u_lod.visibleTo);
  let cand_start = max(vis_from, i32(floor(raw_start)) - 1);
  let cand_end = min(vis_to, i32(ceil(raw_end)) + 1);

  var found: u32 = 0u;
  var open_rel: f32 = 0.0;
  var high_rel: f32 = 0.0;
  var low_rel: f32 = 0.0;
  var close_rel: f32 = 0.0;

  for (var i: i32 = cand_start; i < cand_end; i = i + 1) {
    let bx = i32(floor(origin_x + f32(i) * u_view.colWidth));
    if (bx == px) {
      let b = bars[u32(i)];
      if (found == 0u) {
        found = 1u;
        open_rel = b.openRel;
        high_rel = b.highRel;
        low_rel = b.lowRel;
        close_rel = b.closeRel;
      } else {
        high_rel = max(high_rel, b.highRel);
        low_rel = min(low_rel, b.lowRel);
        close_rel = b.closeRel;
      }
    }
  }

  buckets[idx] = PixelBucketRecord(
    open_rel,
    high_rel,
    low_rel,
    close_rel,
    f32(px),
    found,
    0u,
    0u
  );
}
`;

export const PIXEL_BUCKET_CANDLE_WGSL = `
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

struct PixelBucketRecord {
  openRel: f32,
  highRel: f32,
  lowRel: f32,
  closeRel: f32,
  px: f32,
  valid: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<storage, read> buckets: array<PixelBucketRecord>;

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
  let bucket = buckets[instance_idx];
  if (bucket.valid == 0u) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return out;
  }

  let is_up = bucket.closeRel >= bucket.openRel;
  let color = select(
    vec4<f32>(1.0, 0.42, 0.45, 1.0),
    vec4<f32>(0.27, 0.86, 0.62, 1.0),
    is_up
  );

  let is_body = vertex_idx >= 6u;
  let unit = UNIT_QUAD[vertex_idx % 6u];
  var ry: f32;
  var rh: f32;
  if (!is_body) {
    let y_high = y_of_price_rel(bucket.highRel);
    let y_low = y_of_price_rel(bucket.lowRel);
    ry = y_high;
    rh = max(y_low - y_high, 1.0);
  } else {
    let y_open = y_of_price_rel(bucket.openRel);
    let y_close = y_of_price_rel(bucket.closeRel);
    ry = min(y_open, y_close);
    rh = max(abs(y_close - y_open), 1.0);
  }

  let pos = vec2<f32>(bucket.px, ry) + unit * vec2<f32>(1.0, rh);
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

export const COMPUTE_MERGED_CELLS_WGSL = `
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

struct LodUniform {
  count: u32,
  startCoord: i32,
  plotHeight: u32,
  frameGen: u32,
  visibleTo: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
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

struct MergedRowRecord {
  buyVol: f32,
  sellVol: f32,
  frameGen: u32,
  rowH: f32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<uniform> u_lod: LodUniform;
@group(0) @binding(2) var<storage, read> bars: array<BarRecord>;
@group(0) @binding(3) var<storage, read> cells: array<CellRecord>;
@group(0) @binding(4) var<storage, read_write> merged_rows: array<MergedRowRecord>;
@group(0) @binding(5) var<storage, read_write> merged_bar_max: array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let vis_bar_idx = gid.x;
  if (vis_bar_idx >= u_lod.count) {
    return;
  }
  let bar_idx = u_view.visibleFrom + vis_bar_idx;
  let bar = bars[bar_idx];
  let end = bar.cellOffset + bar.cellCount;
  var merged_max: f32 = 0.0;

  for (var i: u32 = bar.cellOffset; i < end; i = i + 1u) {
    let cell = cells[i];
    let y_top_f = u_view.area.y + (u_view.priceTopRel - (cell.priceBinRel + u_view.priceStep)) / u_view.pricePerPx;
    let y_bot_f = u_view.area.y + (u_view.priceTopRel - cell.priceBinRel) / u_view.pricePerPx;
    let y_top_i = i32(floor(y_top_f));
    let row_idx = y_top_i - u_lod.startCoord;
    if (row_idx >= 0 && row_idx < i32(u_lod.plotHeight)) {
      let slot = vis_bar_idx * u_lod.plotHeight + u32(row_idx);
      var rec = merged_rows[slot];
      if (rec.frameGen != u_lod.frameGen) {
        rec.buyVol = 0.0;
        rec.sellVol = 0.0;
        rec.frameGen = u_lod.frameGen;
        rec.rowH = max(y_bot_f - f32(y_top_i), 1.0);
      }
      rec.buyVol = rec.buyVol + cell.buyVol;
      rec.sellVol = rec.sellVol + cell.sellVol;
      merged_rows[slot] = rec;
      merged_max = max(merged_max, max(rec.buyVol, rec.sellVol));
    }
  }

  merged_bar_max[vis_bar_idx] = merged_max;
}
`;

export const MERGED_CELL_WGSL = `
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

struct LodUniform {
  count: u32,
  startCoord: i32,
  plotHeight: u32,
  frameGen: u32,
  visibleTo: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
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

struct MergedRowRecord {
  buyVol: f32,
  sellVol: f32,
  frameGen: u32,
  rowH: f32,
};

@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(0) @binding(1) var<uniform> u_lod: LodUniform;
@group(0) @binding(2) var<storage, read> bars: array<BarRecord>;
@group(0) @binding(3) var<storage, read> merged_rows: array<MergedRowRecord>;
@group(0) @binding(4) var<storage, read> merged_bar_max: array<f32>;

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
  if ((u_view.flags & 1u) == 0u || u_lod.plotHeight == 0u) {
    return degenerate_out();
  }
  let vis_bar_idx = instance_idx / u_lod.plotHeight;
  if (vis_bar_idx >= u_lod.count) {
    return degenerate_out();
  }
  let rec = merged_rows[instance_idx];
  if (rec.frameGen != u_lod.frameGen) {
    return degenerate_out();
  }
  let merged_max = merged_bar_max[vis_bar_idx];
  if (!(merged_max > 0.0)) {
    return degenerate_out();
  }

  let row_idx = instance_idx % u_lod.plotHeight;
  let bar_idx = u_view.visibleFrom + vis_bar_idx;
  let bar = bars[bar_idx];

  let y_top_raw = f32(u_lod.startCoord + i32(row_idx));
  let y_high = u_view.area.y + (u_view.priceTopRel - bar.highRel) / u_view.pricePerPx;
  let y_low = u_view.area.y + (u_view.priceTopRel - bar.lowRel) / u_view.pricePerPx;
  let bar_top = min(y_high, y_low);
  let bar_bottom = max(max(y_high, y_low), bar_top + 1.0);
  let top_y = max(y_top_raw, bar_top);
  let bot_y = min(y_top_raw + rec.rowH, bar_bottom);
  let h = bot_y - top_y;
  if (!(h > 0.0)) {
    return degenerate_out();
  }
  if (top_y > u_view.area.y + u_view.area.w || bot_y < u_view.area.y) {
    return degenerate_out();
  }

  let x_left = u_view.area.x + u_view.offsetX + f32(bar_idx) * u_view.colWidth;
  let fp_left = x_left + u_view.candleWidth;
  let half_w = (u_view.colWidth - u_view.candleWidth) * 0.5;
  let sub_quad = vertex_idx / 6u;
  let unit = UNIT_QUAD[vertex_idx % 6u];

  var rx: f32;
  var color: vec4<f32>;
  if (sub_quad == 0u) {
    rx = fp_left;
    let sell_a = 0.12 + 0.7 * (rec.sellVol / merged_max);
    color = vec4<f32>(0.85, 0.25, 0.3, sell_a);
  } else {
    rx = fp_left + half_w;
    let buy_a = 0.12 + 0.7 * (rec.buyVol / merged_max);
    color = vec4<f32>(0.13, 0.62, 0.45, buy_a);
  }

  let pos = vec2<f32>(rx, top_y) + unit * vec2<f32>(half_w, h);
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

export const COMPUTE_AUTOSCALE_WGSL = `
struct AutoscaleUniform {
  fromIdx: u32,
  toIdx: u32,
  pad0: u32,
  pad1: u32,
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

struct AutoscaleResult {
  minLowRel: f32,
  maxHighRel: f32,
  validCount: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> u_auto: AutoscaleUniform;
@group(0) @binding(1) var<storage, read> bars: array<BarRecord>;
@group(0) @binding(2) var<storage, read_write> out_range: AutoscaleResult;

var<workgroup> s_min: array<f32, 64>;
var<workgroup> s_max: array<f32, 64>;
var<workgroup> s_valid: array<u32, 64>;

@compute @workgroup_size(64)
fn cs_main(@builtin(local_invocation_index) lid: u32) {
  var local_min: f32 = 0.0;
  var local_max: f32 = 0.0;
  var local_valid: u32 = 0u;

  for (var i: u32 = u_auto.fromIdx + lid; i < u_auto.toIdx; i = i + 64u) {
    let b = bars[i];
    let low_ok = (b.lowRel == b.lowRel) && abs(b.lowRel) < 3.4e38;
    let high_ok = (b.highRel == b.highRel) && abs(b.highRel) < 3.4e38;
    if (low_ok && high_ok) {
      if (local_valid == 0u) {
        local_min = b.lowRel;
        local_max = b.highRel;
        local_valid = 1u;
      } else {
        local_min = min(local_min, b.lowRel);
        local_max = max(local_max, b.highRel);
        local_valid = local_valid + 1u;
      }
    }
  }

  s_min[lid] = local_min;
  s_max[lid] = local_max;
  s_valid[lid] = local_valid;
  workgroupBarrier();

  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (lid < stride) {
      let ov = s_valid[lid + stride];
      if (ov != 0u) {
        if (s_valid[lid] == 0u) {
          s_min[lid] = s_min[lid + stride];
          s_max[lid] = s_max[lid + stride];
        } else {
          s_min[lid] = min(s_min[lid], s_min[lid + stride]);
          s_max[lid] = max(s_max[lid], s_max[lid + stride]);
        }
        s_valid[lid] = s_valid[lid] + ov;
      }
    }
    workgroupBarrier();
  }

  if (lid == 0u) {
    out_range = AutoscaleResult(s_min[0], s_max[0], s_valid[0], 0u);
  }
}
`;

export interface WebGpuNativeScenePipelineOptions {
  readonly supportsTimestampQuery?: boolean;
  readonly maxBufferSize?: number;
}

export interface PreparedNativeFrame {
  readonly ok: boolean;
  readonly lodMode: GpuNativeSceneLodMode;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly visibleCellOffset: number;
  readonly visibleCellCount: number;
  readonly pixelBucketCount: number;
  readonly mergedVisibleBars: number;
  readonly mergedPlotHeight: number;
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

  private readonly lodUniformRaw = new ArrayBuffer(LOD_UNIFORM_BYTES);
  private readonly lodUniformU32 = new Uint32Array(this.lodUniformRaw);
  private readonly lodUniformI32 = new Int32Array(this.lodUniformRaw);

  private readonly autoscaleUniformRaw = new ArrayBuffer(AUTOSCALE_UNIFORM_BYTES);
  private readonly autoscaleUniformU32 = new Uint32Array(this.autoscaleUniformRaw);

  private lodUniformBuffer: any = null;
  private pixelBucketBuffer: any = null;
  private pixelBucketCapacity = 0;
  private pixelBucketComputePipeline: any = null;
  private pixelBucketComputeBindGroupLayout: any = null;
  private pixelBucketComputeBindGroup: any = null;
  private pixelBucketRenderPipeline: any = null;
  private pixelBucketRenderBindGroupLayout: any = null;
  private pixelBucketRenderBindGroup: any = null;

  private mergedRowBuffer: any = null;
  private mergedRowCapacityBytes = 0;
  private mergedBarMaxBuffer: any = null;
  private mergedBarMaxCapacity = 0;
  private mergedFrameGen = 0;
  private mergedCellsComputePipeline: any = null;
  private mergedCellsComputeBindGroupLayout: any = null;
  private mergedCellsComputeBindGroup: any = null;
  private mergedCellsRenderPipeline: any = null;
  private mergedCellsRenderBindGroupLayout: any = null;
  private mergedCellsRenderBindGroup: any = null;

  private autoscaleUniformBuffer: any = null;
  private autoscaleResultBuffer: any = null;
  private autoscaleReadBuffer: any = null;
  private autoscaleComputePipeline: any = null;
  private autoscaleBindGroupLayout: any = null;
  private autoscaleBindGroup: any = null;
  private autoscaleQueuePromise: Promise<void> = Promise.resolve();

  private activeLodMode: GpuNativeSceneLodMode = "standard";
  private pendingPixelBucketCount = 0;
  private pendingMergedVisibleBars = 0;

  private barCellOffsets = new Uint32Array(64);
  private barCellCounts = new Uint32Array(64);
  private syncedBarRefs: Array<FootprintBar | undefined> = [];
  private syncedBarCellRevs = new Uint32Array(64);
  private syncedBarOhlc = new Float64Array(64 * 4);
  private syncedFirstStartTime = Number.NaN;
  private syncedLastStartTime = Number.NaN;

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

  private overflowSeries: FootprintSeries | null = null;
  private overflowResetEpoch = -1;

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

    const maxBarsFit = Math.max(1, Math.floor(this.maxBufferSize / BAR_RECORD_BYTES));
    const maxCellsFit = Math.max(1, Math.floor(this.maxBufferSize / CELL_RECORD_BYTES));
    this.barCapacity = Math.min(64, maxBarsFit);
    this.cellCapacity = Math.min(1024, maxCellsFit);
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
          count: 8, // 2 slots x 4 timestamps (render begin/end + compute begin/end)
        });
        for (let slot = 0; slot < 2; slot++) {
          const resolveBuffer = device.createBuffer({
            label: `NativeSceneTimestampResolve${slot}`,
            size: 32,
            usage: 0x0200 | 0x0004, // QUERY_RESOLVE | COPY_SRC
          });
          const readBuffer = device.createBuffer({
            label: `NativeSceneTimestampRead${slot}`,
            size: 32,
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
    this.pixelBucketComputeBindGroup = null;
    this.mergedCellsComputeBindGroup = null;
    this.mergedCellsRenderBindGroup = null;
    this.autoscaleBindGroup = null;
  }

  private recordBarMetadata(index: number, bar: FootprintBar | undefined): void {
    this.syncedBarRefs[index] = bar;
    this.syncedBarCellRevs[index] = bar ? (bar.cellRevision ?? 0) : 0;
    const ohlcBase = index * 4;
    if (bar) {
      this.syncedBarOhlc[ohlcBase] = bar.open;
      this.syncedBarOhlc[ohlcBase + 1] = bar.high;
      this.syncedBarOhlc[ohlcBase + 2] = bar.low;
      this.syncedBarOhlc[ohlcBase + 3] = bar.close;
    } else {
      this.syncedBarOhlc[ohlcBase] = Number.NaN;
      this.syncedBarOhlc[ohlcBase + 1] = Number.NaN;
      this.syncedBarOhlc[ohlcBase + 2] = Number.NaN;
      this.syncedBarOhlc[ohlcBase + 3] = Number.NaN;
    }
  }

  private packStagingBar(
    stagingBarIndex: number,
    gpuBarIndex: number,
    bar: FootprintBar | undefined,
    origin: number,
    gpuCellOffset: number,
    stagingCellCursor: number,
  ): number {
    const barBase = stagingBarIndex * BAR_RECORD_WORDS;
    if (!bar) {
      this.barStagingF32[barBase] = 0;
      this.barStagingF32[barBase + 1] = 0;
      this.barStagingF32[barBase + 2] = 0;
      this.barStagingF32[barBase + 3] = 0;
      this.barStagingF32[barBase + 4] = 0;
      this.barStagingF32[barBase + 5] = 0;
      this.barStagingU32[barBase + 6] = gpuCellOffset;
      this.barStagingU32[barBase + 7] = 0;
      this.barCellOffsets[gpuBarIndex] = gpuCellOffset;
      this.barCellCounts[gpuBarIndex] = 0;
      this.recordBarMetadata(gpuBarIndex, undefined);
      return stagingCellCursor;
    }

    const cellCount = bar.cells.size;
    this.barStagingF32[barBase] = bar.open - origin;
    this.barStagingF32[barBase + 1] = bar.high - origin;
    this.barStagingF32[barBase + 2] = bar.low - origin;
    this.barStagingF32[barBase + 3] = bar.close - origin;
    this.barStagingF32[barBase + 4] = 0;
    this.barStagingF32[barBase + 5] = 0;
    this.barStagingU32[barBase + 6] = gpuCellOffset;
    this.barStagingU32[barBase + 7] = cellCount;
    this.barCellOffsets[gpuBarIndex] = gpuCellOffset;
    this.barCellCounts[gpuBarIndex] = cellCount;
    this.recordBarMetadata(gpuBarIndex, bar);

    let cursor = stagingCellCursor;
    for (const cell of bar.cells.values()) {
      const cellBase = cursor * CELL_RECORD_WORDS;
      this.cellStagingU32[cellBase] = gpuBarIndex;
      this.cellStagingF32[cellBase + 1] = cell.priceBin - origin;
      this.cellStagingF32[cellBase + 2] = cell.buyVol;
      this.cellStagingF32[cellBase + 3] = cell.sellVol;
      cursor++;
    }
    return cursor;
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

      const nextOffsets = new Uint32Array(cap);
      nextOffsets.set(this.barCellOffsets);
      this.barCellOffsets = nextOffsets;

      const nextCounts = new Uint32Array(cap);
      nextCounts.set(this.barCellCounts);
      this.barCellCounts = nextCounts;

      const nextRevs = new Uint32Array(cap);
      nextRevs.set(this.syncedBarCellRevs);
      this.syncedBarCellRevs = nextRevs;

      const nextOhlc = new Float64Array(cap * 4);
      nextOhlc.set(this.syncedBarOhlc);
      this.syncedBarOhlc = nextOhlc;
    }
    if (cellCount * CELL_RECORD_BYTES > this.cellStagingBuffer.byteLength) {
      let cap = Math.max(256, this.cellStagingBuffer.byteLength / CELL_RECORD_BYTES);
      while (cap < cellCount) cap *= 2;
      this.cellStagingBuffer = new ArrayBuffer(cap * CELL_RECORD_BYTES);
      this.cellStagingF32 = new Float32Array(this.cellStagingBuffer);
      this.cellStagingU32 = new Uint32Array(this.cellStagingBuffer);
    }
  }

  private ensureStorageCapacity(barCount: number, totalCells: number): boolean {
    const maxBarsFit = Math.floor(this.maxBufferSize / BAR_RECORD_BYTES);
    const maxCellsFit = Math.floor(this.maxBufferSize / CELL_RECORD_BYTES);
    if (barCount > maxBarsFit || totalCells > maxCellsFit) {
      return false;
    }

    const targetBarCap = Math.min(maxBarsFit, Math.max(1, barCount + TAIL_BAR_HEADROOM));
    const targetCellCap = Math.min(maxCellsFit, Math.max(1, totalCells + TAIL_CELL_HEADROOM));

    let reallocated = false;
    if (barCount > this.barCapacity) {
      let nextCap = Math.max(64, this.barCapacity);
      while (nextCap < targetBarCap) nextCap *= 2;
      nextCap = Math.min(Math.max(barCount, nextCap), maxBarsFit);
      this.barBuffer?.destroy?.();
      this.barCapacity = nextCap;
      this.barBuffer = this.allocateStorageBuffer("NativeSceneBarStorage", nextCap * BAR_RECORD_BYTES);
      reallocated = true;
    }

    if (totalCells > this.cellCapacity) {
      let nextCap = Math.max(1024, this.cellCapacity);
      while (nextCap < targetCellCap) nextCap *= 2;
      nextCap = Math.min(Math.max(totalCells, nextCap), maxCellsFit);
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
    this.dirtyStart = 0;
    this.dirtyCount = 0;

    if (this.overflowSeries === series && this.overflowResetEpoch === series.resetEpoch) {
      return false;
    }

    const barCount = series.length;

    if (barCount === 0) {
      this.overflowSeries = null;
      this.overflowResetEpoch = -1;
      this.syncedSeries = series;
      this.syncedResetEpoch = series.resetEpoch;
      this.syncedNonTailRevision = series.nonTailRevision;
      this.syncedRevision = series.revision;
      this.syncedBarCount = 0;
      this.syncedBarRefs.length = 0;
      this.syncedFirstStartTime = Number.NaN;
      this.syncedLastStartTime = Number.NaN;
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
          this.recordBarMetadata(tailIdx, tailBar);
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

    // Incremental append path on bar rollover (nonTailRevision advances when a new bar opens).
    if (
      this.syncedSeries === series
      && this.syncedResetEpoch === series.resetEpoch
      && this.syncedBarCount >= 1
      && barCount > this.syncedBarCount
      && barCount <= this.barCapacity
    ) {
      const prevTailIdx = this.syncedBarCount - 1;
      const firstBar = series.at(0);
      const prevTailBar = series.at(prevTailIdx);
      if (
        firstBar?.startTime === this.syncedFirstStartTime
        && prevTailBar?.startTime === this.syncedLastStartTime
      ) {
        let prefixUnchanged = true;
        for (let i = 0; i < prevTailIdx; i++) {
          const b = series.at(i);
          const ohlcBase = i * 4;
          if (
            !b
            || b !== this.syncedBarRefs[i]
            || (b.cellRevision ?? 0) !== this.syncedBarCellRevs[i]
            || b.cells.size !== this.barCellCounts[i]
            || b.open !== this.syncedBarOhlc[ohlcBase]
            || b.high !== this.syncedBarOhlc[ohlcBase + 1]
            || b.low !== this.syncedBarOhlc[ohlcBase + 2]
            || b.close !== this.syncedBarOhlc[ohlcBase + 3]
          ) {
            prefixUnchanged = false;
            break;
          }
        }

        if (prefixUnchanged) {
          const appendBarCount = barCount - prevTailIdx;
          let appendCellCount = 0;
          for (let i = prevTailIdx; i < barCount; i++) {
            const b = series.at(i);
            if (b) appendCellCount += b.cells.size;
          }

          if (this.tailCellOffset + appendCellCount <= this.cellCapacity) {
            this.ensureStagingCapacity(barCount, Math.max(appendCellCount, 1));
            this.syncedBarRefs.length = barCount;

            const origin = this.priceOriginValue;
            let cellCursor = 0;
            for (let i = prevTailIdx; i < barCount; i++) {
              const bar = series.at(i);
              const gpuCellOffset = this.tailCellOffset + cellCursor;
              cellCursor = this.packStagingBar(
                i - prevTailIdx,
                i,
                bar,
                origin,
                gpuCellOffset,
                cellCursor,
              );
            }

            const barSliceBytes = appendBarCount * BAR_RECORD_BYTES;
            const cellSliceBytes = appendCellCount * CELL_RECORD_BYTES;
            this.writeStorageBuffer(
              this.barBuffer,
              prevTailIdx * BAR_RECORD_BYTES,
              this.barStagingBuffer,
              barSliceBytes,
            );
            if (cellSliceBytes > 0) {
              this.writeStorageBuffer(
                this.cellBuffer,
                this.tailCellOffset * CELL_RECORD_BYTES,
                this.cellStagingBuffer,
                cellSliceBytes,
              );
            }

            const dataBytes = barSliceBytes + cellSliceBytes;
            incrementPerformanceCounter("gpu.upload.bytes", dataBytes);
            incrementPerformanceCounter("gpu.native.upload.dataBytes", dataBytes);

            const lastBar = series.at(barCount - 1);
            this.syncedNonTailRevision = series.nonTailRevision;
            this.syncedRevision = series.revision;
            this.syncedBarCount = barCount;
            this.activeBarCount = barCount;
            this.activeCellCount = this.tailCellOffset + appendCellCount;
            this.tailCellOffset = this.barCellOffsets[barCount - 1] ?? 0;
            this.syncedLastStartTime = lastBar?.startTime ?? Number.NaN;
            this.syncedTailCellRevision = lastBar?.cellRevision ?? 0;
            this.syncedTailOpen = lastBar?.open ?? Number.NaN;
            this.syncedTailHigh = lastBar?.high ?? Number.NaN;
            this.syncedTailLow = lastBar?.low ?? Number.NaN;
            this.syncedTailClose = lastBar?.close ?? Number.NaN;
            this.syncedTailCellCount = lastBar?.cells.size ?? 0;
            this.dirtyStart = prevTailIdx;
            this.dirtyCount = appendBarCount;
            return true;
          }
        }
      }
    }

    // Full rebuild path (initial load, resetEpoch, prefix mutation, shrink, or capacity overflow).
    let totalCells = 0;
    for (let i = 0; i < barCount; i++) {
      const bar = series.at(i);
      if (bar) totalCells += bar.cells.size;
    }

    if (!this.ensureStorageCapacity(barCount, totalCells)) {
      this.overflowSeries = series;
      this.overflowResetEpoch = series.resetEpoch;
      return false;
    }

    const firstBar = series.at(0);
    const firstLow = firstBar?.low ?? 0;
    const origin = Number.isFinite(firstLow) ? firstLow : 0;

    this.ensureStagingCapacity(barCount, Math.max(totalCells, 1));
    this.syncedBarRefs.length = barCount;

    let cellCursor = 0;
    for (let i = 0; i < barCount; i++) {
      const bar = series.at(i);
      cellCursor = this.packStagingBar(i, i, bar, origin, cellCursor, cellCursor);
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
    this.overflowSeries = null;
    this.overflowResetEpoch = -1;
    this.priceOriginValue = origin;
    this.syncedSeries = series;
    this.syncedResetEpoch = series.resetEpoch;
    this.syncedNonTailRevision = series.nonTailRevision;
    this.syncedRevision = series.revision;
    this.syncedBarCount = barCount;
    this.activeBarCount = barCount;
    this.activeCellCount = totalCells;
    this.tailCellOffset = this.barCellOffsets[barCount - 1] ?? 0;
    this.syncedFirstStartTime = firstBar?.startTime ?? Number.NaN;
    this.syncedLastStartTime = lastBar?.startTime ?? Number.NaN;
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

  private ensureLodUniformBuffer(): any {
    if (!this.lodUniformBuffer) {
      this.lodUniformBuffer = this.device.createBuffer({
        label: "NativeSceneLodUniform",
        size: LOD_UNIFORM_BYTES,
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
    }
    return this.lodUniformBuffer;
  }

  private createAlphaBlendTarget(): { format: string; blend: any } {
    return {
      format: this.format,
      blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      },
    };
  }

  private ensurePixelBucketResources(bucketCount: number): boolean {
    const needed = Math.max(1, bucketCount);
    const neededBytes = needed * PIXEL_BUCKET_RECORD_BYTES;
    if (neededBytes > this.maxBufferSize) return false;

    const lodUniform = this.ensureLodUniformBuffer();
    if (!this.pixelBucketComputePipeline) {
      const computeMod = this.device.createShaderModule({
        label: "NativeSceneComputePixelBucketShader",
        code: COMPUTE_PIXEL_BUCKET_WGSL,
      });
      const renderMod = this.device.createShaderModule({
        label: "NativeScenePixelBucketCandleShader",
        code: PIXEL_BUCKET_CANDLE_WGSL,
      });
      this.pixelBucketComputeBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeScenePixelBucketComputeBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x4, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x4, buffer: { type: "uniform" } },
          { binding: 2, visibility: 0x4, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: 0x4, buffer: { type: "storage" } },
        ],
      });
      this.pixelBucketRenderBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeScenePixelBucketRenderBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x1, buffer: { type: "read-only-storage" } },
        ],
      });
      this.pixelBucketComputePipeline = this.device.createComputePipeline({
        label: "NativeScenePixelBucketComputePipeline",
        layout: this.device.createPipelineLayout({
          label: "NativeScenePixelBucketComputePipelineLayout",
          bindGroupLayouts: [this.pixelBucketComputeBindGroupLayout],
        }),
        compute: { module: computeMod, entryPoint: "cs_main" },
      });
      this.pixelBucketRenderPipeline = this.device.createRenderPipeline({
        label: "NativeScenePixelBucketCandlePipeline",
        layout: this.device.createPipelineLayout({
          label: "NativeScenePixelBucketRenderPipelineLayout",
          bindGroupLayouts: [this.pixelBucketRenderBindGroupLayout],
        }),
        vertex: { module: renderMod, entryPoint: "vs_main" },
        fragment: { module: renderMod, entryPoint: "fs_main", targets: [this.createAlphaBlendTarget()] },
        primitive: { topology: "triangle-list" },
      });
    }

    if (needed > this.pixelBucketCapacity) {
      const maxFit = Math.floor(this.maxBufferSize / PIXEL_BUCKET_RECORD_BYTES);
      let nextCap = Math.max(256, this.pixelBucketCapacity);
      while (nextCap < needed) nextCap *= 2;
      nextCap = Math.min(Math.max(needed, nextCap), maxFit);
      this.pixelBucketBuffer?.destroy?.();
      this.pixelBucketCapacity = nextCap;
      this.pixelBucketBuffer = this.allocateStorageBuffer("NativeScenePixelBucketStorage", nextCap * PIXEL_BUCKET_RECORD_BYTES);
      this.pixelBucketComputeBindGroup = null;
      this.pixelBucketRenderBindGroup = null;
    }

    if (!this.pixelBucketComputeBindGroup) {
      this.pixelBucketComputeBindGroup = this.device.createBindGroup({
        label: "NativeScenePixelBucketComputeBindGroup",
        layout: this.pixelBucketComputeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.viewUniformBuffer } },
          { binding: 1, resource: { buffer: lodUniform } },
          { binding: 2, resource: { buffer: this.barBuffer } },
          { binding: 3, resource: { buffer: this.pixelBucketBuffer } },
        ],
      });
    }
    if (!this.pixelBucketRenderBindGroup) {
      this.pixelBucketRenderBindGroup = this.device.createBindGroup({
        label: "NativeScenePixelBucketRenderBindGroup",
        layout: this.pixelBucketRenderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.viewUniformBuffer } },
          { binding: 1, resource: { buffer: this.pixelBucketBuffer } },
        ],
      });
    }
    return true;
  }

  private ensureMergedCellsResources(visibleBars: number, plotHeight: number): boolean {
    const neededBytes = visibleBars * plotHeight * MERGED_ROW_RECORD_BYTES;
    const barMaxBytes = visibleBars * 4;
    if (
      neededBytes > MERGED_ROW_BUFFER_MAX_BYTES
      || neededBytes > this.maxBufferSize
      || barMaxBytes > this.maxBufferSize
    ) {
      return false;
    }

    const lodUniform = this.ensureLodUniformBuffer();
    if (!this.mergedCellsComputePipeline) {
      const computeMod = this.device.createShaderModule({
        label: "NativeSceneComputeMergedCellsShader",
        code: COMPUTE_MERGED_CELLS_WGSL,
      });
      const renderMod = this.device.createShaderModule({
        label: "NativeSceneMergedCellsShader",
        code: MERGED_CELL_WGSL,
      });
      this.mergedCellsComputeBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeSceneMergedCellsComputeBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x4, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x4, buffer: { type: "uniform" } },
          { binding: 2, visibility: 0x4, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: 0x4, buffer: { type: "read-only-storage" } },
          { binding: 4, visibility: 0x4, buffer: { type: "storage" } },
          { binding: 5, visibility: 0x4, buffer: { type: "storage" } },
        ],
      });
      this.mergedCellsRenderBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeSceneMergedCellsRenderBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x1, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x1, buffer: { type: "uniform" } },
          { binding: 2, visibility: 0x1, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: 0x1, buffer: { type: "read-only-storage" } },
          { binding: 4, visibility: 0x1, buffer: { type: "read-only-storage" } },
        ],
      });
      this.mergedCellsComputePipeline = this.device.createComputePipeline({
        label: "NativeSceneMergedCellsComputePipeline",
        layout: this.device.createPipelineLayout({
          label: "NativeSceneMergedCellsComputePipelineLayout",
          bindGroupLayouts: [this.mergedCellsComputeBindGroupLayout],
        }),
        compute: { module: computeMod, entryPoint: "cs_main" },
      });
      this.mergedCellsRenderPipeline = this.device.createRenderPipeline({
        label: "NativeSceneMergedCellsRenderPipeline",
        layout: this.device.createPipelineLayout({
          label: "NativeSceneMergedCellsRenderPipelineLayout",
          bindGroupLayouts: [this.mergedCellsRenderBindGroupLayout],
        }),
        vertex: { module: renderMod, entryPoint: "vs_main" },
        fragment: { module: renderMod, entryPoint: "fs_main", targets: [this.createAlphaBlendTarget()] },
        primitive: { topology: "triangle-list" },
      });
    }

    const safeNeededBytes = Math.max(16, neededBytes);
    if (safeNeededBytes > this.mergedRowCapacityBytes) {
      const capMax = Math.min(MERGED_ROW_BUFFER_MAX_BYTES, this.maxBufferSize);
      let nextBytes = Math.max(64 * 1024, this.mergedRowCapacityBytes);
      while (nextBytes < safeNeededBytes) nextBytes *= 2;
      nextBytes = Math.min(Math.max(safeNeededBytes, nextBytes), capMax);
      this.mergedRowBuffer?.destroy?.();
      this.mergedRowCapacityBytes = nextBytes;
      this.mergedRowBuffer = this.allocateStorageBuffer("NativeSceneMergedRowStorage", nextBytes);
      this.mergedCellsComputeBindGroup = null;
      this.mergedCellsRenderBindGroup = null;
    }

    const safeBars = Math.max(4, visibleBars);
    if (safeBars > this.mergedBarMaxCapacity) {
      const maxBarFit = Math.floor(this.maxBufferSize / 4);
      let nextCap = Math.max(64, this.mergedBarMaxCapacity);
      while (nextCap < safeBars) nextCap *= 2;
      nextCap = Math.min(Math.max(safeBars, nextCap), maxBarFit);
      this.mergedBarMaxBuffer?.destroy?.();
      this.mergedBarMaxCapacity = nextCap;
      this.mergedBarMaxBuffer = this.allocateStorageBuffer("NativeSceneMergedBarMaxStorage", nextCap * 4);
      this.mergedCellsComputeBindGroup = null;
      this.mergedCellsRenderBindGroup = null;
    }

    if (!this.mergedCellsComputeBindGroup) {
      this.mergedCellsComputeBindGroup = this.device.createBindGroup({
        label: "NativeSceneMergedCellsComputeBindGroup",
        layout: this.mergedCellsComputeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.viewUniformBuffer } },
          { binding: 1, resource: { buffer: lodUniform } },
          { binding: 2, resource: { buffer: this.barBuffer } },
          { binding: 3, resource: { buffer: this.cellBuffer } },
          { binding: 4, resource: { buffer: this.mergedRowBuffer } },
          { binding: 5, resource: { buffer: this.mergedBarMaxBuffer } },
        ],
      });
    }
    if (!this.mergedCellsRenderBindGroup) {
      this.mergedCellsRenderBindGroup = this.device.createBindGroup({
        label: "NativeSceneMergedCellsRenderBindGroup",
        layout: this.mergedCellsRenderBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.viewUniformBuffer } },
          { binding: 1, resource: { buffer: lodUniform } },
          { binding: 2, resource: { buffer: this.barBuffer } },
          { binding: 3, resource: { buffer: this.mergedRowBuffer } },
          { binding: 4, resource: { buffer: this.mergedBarMaxBuffer } },
        ],
      });
    }
    return true;
  }

  private ensureAutoscaleResources(): boolean {
    if (!this.autoscaleComputePipeline) {
      const mod = this.device.createShaderModule({
        label: "NativeSceneComputeAutoscaleShader",
        code: COMPUTE_AUTOSCALE_WGSL,
      });
      this.autoscaleUniformBuffer = this.device.createBuffer({
        label: "NativeSceneAutoscaleUniform",
        size: AUTOSCALE_UNIFORM_BYTES,
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });
      this.autoscaleResultBuffer = this.device.createBuffer({
        label: "NativeSceneAutoscaleResult",
        size: AUTOSCALE_RESULT_BYTES,
        usage: 0x0080 | 0x0004, // STORAGE | COPY_SRC
      });
      this.autoscaleReadBuffer = this.device.createBuffer({
        label: "NativeSceneAutoscaleRead",
        size: AUTOSCALE_RESULT_BYTES,
        usage: 0x0008 | 0x0001, // COPY_DST | MAP_READ
      });
      this.autoscaleBindGroupLayout = this.device.createBindGroupLayout({
        label: "NativeSceneAutoscaleBindGroupLayout",
        entries: [
          { binding: 0, visibility: 0x4, buffer: { type: "uniform" } },
          { binding: 1, visibility: 0x4, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: 0x4, buffer: { type: "storage" } },
        ],
      });
      this.autoscaleComputePipeline = this.device.createComputePipeline({
        label: "NativeSceneAutoscaleComputePipeline",
        layout: this.device.createPipelineLayout({
          label: "NativeSceneAutoscalePipelineLayout",
          bindGroupLayouts: [this.autoscaleBindGroupLayout],
        }),
        compute: { module: mod, entryPoint: "cs_main" },
      });
    }
    if (!this.autoscaleBindGroup) {
      this.autoscaleBindGroup = this.device.createBindGroup({
        label: "NativeSceneAutoscaleBindGroup",
        layout: this.autoscaleBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.autoscaleUniformBuffer } },
          { binding: 1, resource: { buffer: this.barBuffer } },
          { binding: 2, resource: { buffer: this.autoscaleResultBuffer } },
        ],
      });
    }
    return true;
  }

  prepareFrame(scene: GpuNativeSceneInput, logicalWidth: number, logicalHeight: number): PreparedNativeFrame {
    const emptyFail: PreparedNativeFrame = {
      ok: false,
      lodMode: scene.lodMode ?? "standard",
      visibleFrom: 0,
      visibleTo: 0,
      visibleCellOffset: 0,
      visibleCellCount: 0,
      pixelBucketCount: 0,
      mergedVisibleBars: 0,
      mergedPlotHeight: 0,
    };
    if (this.disposed) {
      return emptyFail;
    }

    if (!this.syncSeries(scene.series)) {
      return emptyFail;
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

    const lodMode: GpuNativeSceneLodMode = scene.lodMode ?? "standard";
    this.activeLodMode = lodMode;
    this.pendingPixelBucketCount = 0;
    this.pendingMergedVisibleBars = 0;
    let pixelBucketCount = 0;
    let mergedVisibleBars = 0;
    let mergedPlotHeight = 0;

    if (lodMode === "pixel-bucket" && scene.drawCandles && visibleTo > visibleFrom) {
      const minPx = Math.floor(area.left + offsetX + visibleFrom * safeColWidth);
      const maxPx = Math.floor(area.left + offsetX + (visibleTo - 1) * safeColWidth);
      pixelBucketCount = Math.max(0, maxPx - minPx + 1);
      if (pixelBucketCount > 0) {
        if (!this.ensurePixelBucketResources(pixelBucketCount)) {
          return emptyFail;
        }
        this.lodUniformU32[0] = pixelBucketCount;
        this.lodUniformI32[1] = minPx;
        this.lodUniformU32[2] = 0;
        this.lodUniformU32[3] = 0;
        this.lodUniformU32[4] = visibleTo;
        this.lodUniformU32[5] = 0;
        this.lodUniformU32[6] = 0;
        this.lodUniformU32[7] = 0;
        this.writeStorageBuffer(this.lodUniformBuffer, 0, this.lodUniformRaw, LOD_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.upload.bytes", LOD_UNIFORM_BYTES);
        incrementPerformanceCounter("gpu.native.upload.uniformBytes", LOD_UNIFORM_BYTES);
        this.pendingPixelBucketCount = pixelBucketCount;
      }
    } else if (lodMode === "merged-cells" && scene.drawFootprint && scene.drawHeat && visibleTo > visibleFrom) {
      mergedVisibleBars = visibleTo - visibleFrom;
      const areaTopInt = Math.floor(area.top);
      mergedPlotHeight = Math.max(1, Math.ceil(area.height));
      if (!this.ensureMergedCellsResources(mergedVisibleBars, mergedPlotHeight)) {
        return emptyFail;
      }
      this.mergedFrameGen = ((this.mergedFrameGen + 1) >>> 0) || 1;
      this.lodUniformU32[0] = mergedVisibleBars;
      this.lodUniformI32[1] = areaTopInt;
      this.lodUniformU32[2] = mergedPlotHeight;
      this.lodUniformU32[3] = this.mergedFrameGen;
      this.lodUniformU32[4] = visibleTo;
      this.lodUniformU32[5] = 0;
      this.lodUniformU32[6] = 0;
      this.lodUniformU32[7] = 0;
      this.writeStorageBuffer(this.lodUniformBuffer, 0, this.lodUniformRaw, LOD_UNIFORM_BYTES);
      incrementPerformanceCounter("gpu.upload.bytes", LOD_UNIFORM_BYTES);
      incrementPerformanceCounter("gpu.native.upload.uniformBytes", LOD_UNIFORM_BYTES);
      this.pendingMergedVisibleBars = mergedVisibleBars;
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

    return {
      ok: true,
      lodMode,
      visibleFrom,
      visibleTo,
      visibleCellOffset,
      visibleCellCount,
      pixelBucketCount,
      mergedVisibleBars,
      mergedPlotHeight,
    };
  }

  needsComputeDispatch(): boolean {
    if (this.disposed) return false;
    return this.dirtyCount > 0 || this.pendingPixelBucketCount > 0 || this.pendingMergedVisibleBars > 0;
  }

  computeTimestampWritesFor(slot: number): { querySet: any; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number } {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: slot * 4 + 2,
      endOfPassWriteIndex: slot * 4 + 3,
    };
  }

  recordComputePass(commandEncoder: any, tsSlot: number | null = null): void {
    if (this.disposed || !this.needsComputeDispatch()) return;
    const pass = commandEncoder.beginComputePass({
      label: "NativeSceneComputeStatsPass",
      ...(tsSlot !== null && this.querySet ? { timestampWrites: this.computeTimestampWritesFor(tsSlot) } : {}),
    });
    if (this.dirtyCount > 0) {
      pass.setPipeline(this.computePipeline);
      pass.setBindGroup(0, this.computeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.dirtyCount / COMPUTE_WORKGROUP_SIZE));
    }
    if (this.activeLodMode === "pixel-bucket" && this.pendingPixelBucketCount > 0 && this.pixelBucketComputePipeline) {
      pass.setPipeline(this.pixelBucketComputePipeline);
      pass.setBindGroup(0, this.pixelBucketComputeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.pendingPixelBucketCount / COMPUTE_WORKGROUP_SIZE));
    } else if (this.activeLodMode === "merged-cells" && this.pendingMergedVisibleBars > 0 && this.mergedCellsComputePipeline) {
      pass.setPipeline(this.mergedCellsComputePipeline);
      pass.setBindGroup(0, this.mergedCellsComputeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(this.pendingMergedVisibleBars / COMPUTE_WORKGROUP_SIZE));
    }
    pass.end();
  }

  recordRenderPasses(passEncoder: any, scene: GpuNativeSceneInput, prepared: PreparedNativeFrame): void {
    if (this.disposed || prepared.visibleTo <= prepared.visibleFrom) return;
    const visibleBarCount = prepared.visibleTo - prepared.visibleFrom;

    if (prepared.lodMode === "pixel-bucket") {
      if (scene.drawCandles && prepared.pixelBucketCount > 0 && this.pixelBucketRenderPipeline) {
        passEncoder.setPipeline(this.pixelBucketRenderPipeline);
        passEncoder.setBindGroup(0, this.pixelBucketRenderBindGroup);
        passEncoder.draw(12, prepared.pixelBucketCount, 0, 0);
      }
      return;
    }

    if (scene.drawCandles && scene.candleStyle !== "none" && visibleBarCount > 0) {
      passEncoder.setPipeline(this.candlePipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(12, visibleBarCount, 0, 0);
    }

    if (prepared.lodMode === "merged-cells") {
      const mergedInstances = prepared.mergedVisibleBars * prepared.mergedPlotHeight;
      if (scene.drawFootprint && scene.drawHeat && mergedInstances > 0 && this.mergedCellsRenderPipeline) {
        passEncoder.setPipeline(this.mergedCellsRenderPipeline);
        passEncoder.setBindGroup(0, this.mergedCellsRenderBindGroup);
        passEncoder.draw(12, mergedInstances, 0, 0);
      }
      return;
    }

    if (scene.drawFootprint && (scene.drawHeat || scene.drawPoc) && prepared.visibleCellCount > 0) {
      passEncoder.setPipeline(this.footprintPipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(18, prepared.visibleCellCount, 0, 0);
    }
  }

  /** Non-blocking GPU visible price autoscale reduction over `[visibleFrom, visibleTo)`. */
  readVisiblePriceRangeAsync(
    series: FootprintSeries,
    visibleFrom: number,
    visibleTo: number,
  ): Promise<{ min: number; max: number } | null> {
    const task = this.autoscaleQueuePromise.then(() => this.runAutoscaleReadback(series, visibleFrom, visibleTo));
    this.autoscaleQueuePromise = task.then(() => undefined, () => undefined);
    return task;
  }

  private async runAutoscaleReadback(
    series: FootprintSeries,
    visibleFrom: number,
    visibleTo: number,
  ): Promise<{ min: number; max: number } | null> {
    if (this.disposed) return null;
    const from = Math.max(0, Math.floor(visibleFrom));
    const to = Math.min(series.length, Math.ceil(visibleTo));
    if (from >= to) return null;

    if (
      this.syncedSeries !== series
      || this.syncedResetEpoch !== series.resetEpoch
      || this.syncedRevision !== series.revision
    ) {
      if (!this.syncSeries(series)) return null;
    }
    if (this.activeBarCount === 0 || to > this.activeBarCount) return null;

    if (!this.ensureAutoscaleResources() || typeof this.autoscaleReadBuffer?.mapAsync !== "function") {
      return null;
    }

    const commandEncoder = this.device.createCommandEncoder({
      label: "NativeSceneAutoscaleCommandEncoder",
    });

    if (this.dirtyCount > 0) {
      this.computeUniformU32[0] = this.dirtyStart;
      this.computeUniformU32[1] = this.dirtyCount;
      this.computeUniformU32[2] = 0;
      this.computeUniformU32[3] = 0;
      this.writeStorageBuffer(this.computeUniformBuffer, 0, this.computeUniformRaw, COMPUTE_UNIFORM_BYTES);
      const statsPass = commandEncoder.beginComputePass({ label: "NativeSceneComputeStatsPass" });
      statsPass.setPipeline(this.computePipeline);
      statsPass.setBindGroup(0, this.computeBindGroup);
      statsPass.dispatchWorkgroups(Math.ceil(this.dirtyCount / COMPUTE_WORKGROUP_SIZE));
      statsPass.end();
      this.dirtyCount = 0;
    }

    this.autoscaleUniformU32[0] = from;
    this.autoscaleUniformU32[1] = to;
    this.autoscaleUniformU32[2] = 0;
    this.autoscaleUniformU32[3] = 0;
    this.writeStorageBuffer(this.autoscaleUniformBuffer, 0, this.autoscaleUniformRaw, AUTOSCALE_UNIFORM_BYTES);

    const autoPass = commandEncoder.beginComputePass({ label: "NativeSceneAutoscalePass" });
    autoPass.setPipeline(this.autoscaleComputePipeline);
    autoPass.setBindGroup(0, this.autoscaleBindGroup);
    autoPass.dispatchWorkgroups(1);
    autoPass.end();

    commandEncoder.copyBufferToBuffer(
      this.autoscaleResultBuffer,
      0,
      this.autoscaleReadBuffer,
      0,
      AUTOSCALE_RESULT_BYTES,
    );
    this.device.queue.submit([commandEncoder.finish()]);

    let mapped = false;
    try {
      await Promise.resolve(this.autoscaleReadBuffer.mapAsync(0x0001));
      mapped = true;
      if (this.disposed) return null;
      const range = this.autoscaleReadBuffer.getMappedRange();
      const f32 = new Float32Array(range);
      const u32 = new Uint32Array(range);
      const validCount = u32[2] ?? 0;
      const minLowRel = f32[0];
      const maxHighRel = f32[1];
      if (validCount === 0 || !Number.isFinite(minLowRel) || !Number.isFinite(maxHighRel)) {
        return null;
      }
      return {
        min: minLowRel + this.priceOriginValue,
        max: maxHighRel + this.priceOriginValue,
      };
    } catch {
      return null;
    } finally {
      if (mapped) {
        try { this.autoscaleReadBuffer?.unmap?.(); } catch {}
      }
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
      beginningOfPassWriteIndex: slot * 4,
      endOfPassWriteIndex: slot * 4 + 1,
    };
  }

  resolveTimestampPass(commandEncoder: any, slotIndex: number, ranCompute = false): void {
    const slot = this.timestampSlots[slotIndex];
    if (!slot || !this.querySet) return;
    if (typeof commandEncoder.resolveQuerySet !== "function" || typeof commandEncoder.copyBufferToBuffer !== "function") {
      return;
    }
    const queryCount = ranCompute ? 4 : 2;
    const byteSize = ranCompute ? 32 : 16;
    commandEncoder.resolveQuerySet(this.querySet, slotIndex * 4, queryCount, slot.resolveBuffer, 0);
    commandEncoder.copyBufferToBuffer(slot.resolveBuffer, 0, slot.readBuffer, 0, byteSize);
  }

  readbackTimestampPass(slotIndex: number, ranCompute = false): void {
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
          const renderNs = Number(values[1] - values[0]);
          let validComputeNs = 0;
          if (ranCompute && values.length >= 4) {
            const computeNs = Number(values[3] - values[2]);
            if (Number.isFinite(computeNs) && computeNs > 0) {
              validComputeNs = computeNs;
              recordPerformanceDuration("chart.gpu.timestamp.compute.ms", computeNs / 1_000_000);
            }
          }
          if (Number.isFinite(renderNs) && renderNs >= 0) {
            recordPerformanceDuration("chart.gpu.timestamp.ms", (renderNs + validComputeNs) / 1_000_000);
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
    this.overflowSeries = null;
    this.overflowResetEpoch = -1;
    this.syncedBarRefs.length = 0;
    try {
      this.viewUniformBuffer?.destroy?.();
      this.computeUniformBuffer?.destroy?.();
      this.lodUniformBuffer?.destroy?.();
      this.barBuffer?.destroy?.();
      this.cellBuffer?.destroy?.();
      this.pixelBucketBuffer?.destroy?.();
      this.mergedRowBuffer?.destroy?.();
      this.mergedBarMaxBuffer?.destroy?.();
      this.autoscaleUniformBuffer?.destroy?.();
      this.autoscaleResultBuffer?.destroy?.();
      this.autoscaleReadBuffer?.destroy?.();
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
