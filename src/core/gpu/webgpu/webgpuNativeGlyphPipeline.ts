import type { ChartArea } from "../../engine/view.js";
import { incrementPerformanceCounter } from "../../performanceTelemetry.js";
import { createScratchCanvas, type Canvas2dContext } from "../canvasTarget.js";
import type { NativeGlyphSink } from "../gpuBackend.js";

export const GLYPH_CHARSET = "0123456789.+-kM%,KB ";
export const GLYPH_COUNT = GLYPH_CHARSET.length; // 20
export const GLYPH_FONT_PX = 32;
export const GLYPH_CELL_SIZE = 48;
export const GLYPH_ATLAS_WIDTH = 1024;
export const GLYPH_ATLAS_HEIGHT = 64;
export const GLYPH_ATLAS_COLS = Math.floor(GLYPH_ATLAS_WIDTH / GLYPH_CELL_SIZE); // 21
export const GLYPH_SDF_SPREAD = 8;
export const GLYPH_INSTANCE_WORDS = 6;
export const GLYPH_INSTANCE_BYTES = GLYPH_INSTANCE_WORDS * 4; // 24

const EDT_INF = 1e9;
const DEFAULT_ADVANCE_RATIO = 0.6;

export const GLYPH_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < GLYPH_CHARSET.length; i++) {
  const code = GLYPH_CHARSET.charCodeAt(i);
  if (code < 128) GLYPH_LOOKUP[code] = i;
}

export function glyphIndexForCharCode(code: number): number {
  return code >= 0 && code < 128 ? GLYPH_LOOKUP[code] : -1;
}

export interface GlyphAtlasData {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly fontPx: number;
  readonly spread: number;
  readonly advanceRatio: number;
  readonly pixels: Uint8Array;
}

let cachedAtlas: GlyphAtlasData | null = null;

/**
 * Separable 1D squared Euclidean Distance Transform (Felzenszwalb & Huttenlocher, 2012).
 * Exact O(n) lower envelope of parabolas.
 */
export function edt1d(
  f: Float32Array,
  n: number,
  d: Float32Array,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -1e12;
  z[1] = 1e12;
  for (let q = 1; q < n; q++) {
    let vk = v[k];
    let s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * (q - vk));
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = ((f[q] + q * q) - (f[vk] + vk * vk)) / (2 * (q - vk));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e12;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function edt2d(
  grid: Float32Array,
  width: number,
  height: number,
  scratchF: Float32Array,
  scratchD: Float32Array,
  scratchV: Int32Array,
  scratchZ: Float32Array,
): void {
  // Columns
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      scratchF[y] = grid[y * width + x];
    }
    edt1d(scratchF, height, scratchD, scratchV, scratchZ);
    for (let y = 0; y < height; y++) {
      grid[y * width + x] = scratchD[y];
    }
  }
  // Rows
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      scratchF[x] = grid[rowOffset + x];
    }
    edt1d(scratchF, width, scratchD, scratchV, scratchZ);
    for (let x = 0; x < width; x++) {
      grid[rowOffset + x] = scratchD[x];
    }
  }
}

/**
 * Computes normalized [0..255] SDF for a binary inside mask (1 = inside, 0 = outside)
 * of dimensions `cellSize x cellSize`. Inside pixels encode > 127, outside pixels < 128.
 */
export function computeGlyphCellSdf(
  mask: Uint8Array,
  cellSize = GLYPH_CELL_SIZE,
  spread = GLYPH_SDF_SPREAD,
): Uint8Array {
  const len = cellSize * cellSize;
  const outsideDistSq = new Float32Array(len);
  const insideDistSq = new Float32Array(len);
  let anyInside = false;
  let anyOutside = false;

  for (let i = 0; i < len; i++) {
    if (mask[i] > 0) {
      anyInside = true;
      outsideDistSq[i] = 0;
      insideDistSq[i] = EDT_INF;
    } else {
      anyOutside = true;
      outsideDistSq[i] = EDT_INF;
      insideDistSq[i] = 0;
    }
  }

  const out = new Uint8Array(len);
  if (!anyInside) {
    return out; // All zero (completely outside)
  }
  if (!anyOutside) {
    out.fill(255);
    return out;
  }

  const scratchF = new Float32Array(cellSize);
  const scratchD = new Float32Array(cellSize);
  const scratchV = new Int32Array(cellSize);
  const scratchZ = new Float32Array(cellSize + 1);

  edt2d(outsideDistSq, cellSize, cellSize, scratchF, scratchD, scratchV, scratchZ);
  edt2d(insideDistSq, cellSize, cellSize, scratchF, scratchD, scratchV, scratchZ);

  const twoSpread = 2 * spread;
  for (let i = 0; i < len; i++) {
    const dOut = outsideDistSq[i] > 0 ? Math.max(0, Math.sqrt(outsideDistSq[i]) - 0.5) : 0;
    const dIn = insideDistSq[i] > 0 ? Math.max(0, Math.sqrt(insideDistSq[i]) - 0.5) : 0;
    const normalized = (dIn - dOut) / twoSpread;
    const clamped = Math.max(-0.5, Math.min(1.0, normalized));
    const encoded = Math.max(0, Math.min(1, 0.5 + clamped));
    out[i] = Math.round(encoded * 255);
  }
  return out;
}

function fillSyntheticGlyphMask(charIndex: number, char: string, cellSize: number): Uint8Array {
  const mask = new Uint8Array(cellSize * cellSize);
  if (char === " ") return mask;

  // Deterministic bit-pattern strokes centered inside [8..40) for Node fallback tests
  const margin = Math.floor((cellSize - GLYPH_FONT_PX) / 2);
  const end = cellSize - margin;
  const midY = Math.floor(cellSize / 2);
  const midX = Math.floor(cellSize / 2);
  const pattern = (charIndex + 1) * 0x9e3779b1;
  for (let y = margin + 4; y < end - 4; y++) {
    for (let x = margin + 6; x < end - 6; x++) {
      const border = x <= margin + 8 || x >= end - 9 || y <= margin + 6 || y >= end - 7;
      const bar = y >= midY - 1 && y <= midY + 1 && ((pattern & (1 << (x % 8))) !== 0 || x < midX + 3);
      if (border || bar) {
        mask[y * cellSize + x] = 1;
      }
    }
  }
  return mask;
}

function buildGlyphAtlasData(): GlyphAtlasData {
  const pixels = new Uint8Array(GLYPH_ATLAS_WIDTH * GLYPH_ATLAS_HEIGHT * 4);
  let advanceRatio = DEFAULT_ADVANCE_RATIO;

  let ctx: Canvas2dContext | null = null;
  try {
    const canvas = createScratchCanvas(GLYPH_CELL_SIZE, GLYPH_CELL_SIZE);
    ctx = canvas ? (canvas.getContext("2d", { willReadFrequently: true }) as Canvas2dContext | null) : null;
  } catch {
    ctx = null;
  }

  if (ctx) {
    ctx.font = `${GLYPH_FONT_PX}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const measured = ctx.measureText("0").width;
    if (Number.isFinite(measured) && measured > 0) {
      advanceRatio = measured / GLYPH_FONT_PX;
    }
  }

  const mask = new Uint8Array(GLYPH_CELL_SIZE * GLYPH_CELL_SIZE);
  const scratchF = new Float32Array(GLYPH_CELL_SIZE);
  const scratchD = new Float32Array(GLYPH_CELL_SIZE);
  const scratchV = new Int32Array(GLYPH_CELL_SIZE);
  const scratchZ = new Float32Array(GLYPH_CELL_SIZE + 1);
  const outsideDistSq = new Float32Array(GLYPH_CELL_SIZE * GLYPH_CELL_SIZE);
  const insideDistSq = new Float32Array(GLYPH_CELL_SIZE * GLYPH_CELL_SIZE);
  const twoSpread = 2 * GLYPH_SDF_SPREAD;

  for (let idx = 0; idx < GLYPH_COUNT; idx++) {
    const ch = GLYPH_CHARSET[idx];
    const col = idx % GLYPH_ATLAS_COLS;
    const row = Math.floor(idx / GLYPH_ATLAS_COLS);
    const originX = col * GLYPH_CELL_SIZE;
    const originY = row * GLYPH_CELL_SIZE;

    let anyInside = false;
    let anyOutside = false;

    if (ctx) {
      ctx.clearRect(0, 0, GLYPH_CELL_SIZE, GLYPH_CELL_SIZE);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(ch, GLYPH_CELL_SIZE * 0.5, GLYPH_CELL_SIZE * 0.5);
      const rgba = ctx.getImageData(0, 0, GLYPH_CELL_SIZE, GLYPH_CELL_SIZE).data;
      for (let i = 0; i < mask.length; i++) {
        const inside = rgba[i * 4 + 3] >= 128;
        if (inside) {
          anyInside = true;
          mask[i] = 1;
          outsideDistSq[i] = 0;
          insideDistSq[i] = EDT_INF;
        } else {
          anyOutside = true;
          mask[i] = 0;
          outsideDistSq[i] = EDT_INF;
          insideDistSq[i] = 0;
        }
      }
    } else {
      const synth = fillSyntheticGlyphMask(idx, ch, GLYPH_CELL_SIZE);
      for (let i = 0; i < mask.length; i++) {
        if (synth[i] > 0) {
          anyInside = true;
          mask[i] = 1;
          outsideDistSq[i] = 0;
          insideDistSq[i] = EDT_INF;
        } else {
          anyOutside = true;
          mask[i] = 0;
          outsideDistSq[i] = EDT_INF;
          insideDistSq[i] = 0;
        }
      }
    }

    if (!anyInside) {
      // Space or empty glyph: stays 0 in atlas pixels
      continue;
    }

    if (anyOutside) {
      edt2d(outsideDistSq, GLYPH_CELL_SIZE, GLYPH_CELL_SIZE, scratchF, scratchD, scratchV, scratchZ);
      edt2d(insideDistSq, GLYPH_CELL_SIZE, GLYPH_CELL_SIZE, scratchF, scratchD, scratchV, scratchZ);
    }

    for (let y = 0; y < GLYPH_CELL_SIZE; y++) {
      const cellRow = y * GLYPH_CELL_SIZE;
      const atlasRow = (originY + y) * GLYPH_ATLAS_WIDTH;
      for (let x = 0; x < GLYPH_CELL_SIZE; x++) {
        const i = cellRow + x;
        let byteVal = 255;
        if (anyOutside) {
          const dOut = outsideDistSq[i] > 0 ? Math.max(0, Math.sqrt(outsideDistSq[i]) - 0.5) : 0;
          const dIn = insideDistSq[i] > 0 ? Math.max(0, Math.sqrt(insideDistSq[i]) - 0.5) : 0;
          const clamped = Math.max(-0.5, Math.min(1.0, (dIn - dOut) / twoSpread));
          byteVal = Math.round(Math.max(0, Math.min(1, 0.5 + clamped)) * 255);
        }
        const dst = (atlasRow + originX + x) * 4;
        pixels[dst] = byteVal;
        pixels[dst + 1] = byteVal;
        pixels[dst + 2] = byteVal;
        pixels[dst + 3] = byteVal;
      }
    }
  }

  return {
    width: GLYPH_ATLAS_WIDTH,
    height: GLYPH_ATLAS_HEIGHT,
    cellSize: GLYPH_CELL_SIZE,
    fontPx: GLYPH_FONT_PX,
    spread: GLYPH_SDF_SPREAD,
    advanceRatio,
    pixels,
  };
}

export function getOrCreateGlyphAtlas(): GlyphAtlasData {
  if (!cachedAtlas) {
    cachedAtlas = buildGlyphAtlasData();
  }
  return cachedAtlas;
}

export function resetGlyphAtlasForTest(): void {
  cachedAtlas = null;
}

export const GLYPH_WGSL = `
struct Uniforms {
  resolution: vec2<f32>,
  _pad: vec2<f32>,
  clipArea: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u_uniforms: Uniforms;
@group(0) @binding(1) var u_atlas: texture_2d<f32>;
@group(0) @binding(2) var u_sampler: sampler;

struct InstanceInput {
  @location(0) rect: vec4<f32>,
  @location(1) glyphIndex: u32,
  @location(2) colorPacked: u32,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) screenPos: vec2<f32>,
};

var<private> UNIT_QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0)
);

const ATLAS_COLS: u32 = ${GLYPH_ATLAS_COLS}u;
const CELL_U: f32 = ${GLYPH_CELL_SIZE}.0 / ${GLYPH_ATLAS_WIDTH}.0;
const CELL_V: f32 = ${GLYPH_CELL_SIZE}.0 / ${GLYPH_ATLAS_HEIGHT}.0;

@vertex
fn vs_main(@builtin(vertex_index) vertex_idx: u32, instance: InstanceInput) -> VertexOutput {
  var out: VertexOutput;
  let unit = UNIT_QUAD[vertex_idx];
  let pos = instance.rect.xy + unit * instance.rect.zw;
  let clip_x = (pos.x / u_uniforms.resolution.x) * 2.0 - 1.0;
  let clip_y = 1.0 - (pos.y / u_uniforms.resolution.y) * 2.0;
  out.position = vec4<f32>(clip_x, clip_y, 0.0, 1.0);

  let col = instance.glyphIndex % ATLAS_COLS;
  let row = instance.glyphIndex / ATLAS_COLS;
  out.uv = vec2<f32>((f32(col) + unit.x) * CELL_U, (f32(row) + unit.y) * CELL_V);
  out.color = unpack4x8unorm(instance.colorPacked);
  out.screenPos = pos;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let d = textureSample(u_atlas, u_sampler, in.uv).a;
  let w = clamp(fwidth(d) * 0.75, 0.02, 0.25);
  if (
    in.screenPos.x < u_uniforms.clipArea.x ||
    in.screenPos.x > u_uniforms.clipArea.z ||
    in.screenPos.y < u_uniforms.clipArea.y ||
    in.screenPos.y > u_uniforms.clipArea.w
  ) {
    discard;
  }
  let alpha = smoothstep(0.5 - w, 0.5 + w, d) * in.color.a;
  if (alpha <= 0.003) {
    discard;
  }
  return vec4<f32>(in.color.rgb, alpha);
}
`;

const SPACE_GLYPH_INDEX = GLYPH_LOOKUP[" ".charCodeAt(0)];

export class WebGpuGlyphSink implements NativeGlyphSink {
  f32: Float32Array;
  u32: Uint32Array;
  count = 0;
  private capacityGlyphs: number;
  private readonly advanceRatio: number;

  constructor(initialCapacityGlyphs = 4096, advanceRatio = getOrCreateGlyphAtlas().advanceRatio) {
    this.capacityGlyphs = Math.max(256, initialCapacityGlyphs);
    const buffer = new ArrayBuffer(this.capacityGlyphs * GLYPH_INSTANCE_BYTES);
    this.f32 = new Float32Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.advanceRatio = advanceRatio > 0 ? advanceRatio : DEFAULT_ADVANCE_RATIO;
  }

  reset(): void {
    this.count = 0;
  }

  private ensureAdditionalCapacity(extraGlyphs: number): void {
    const needed = this.count + extraGlyphs;
    if (needed <= this.capacityGlyphs) return;
    let nextCap = this.capacityGlyphs;
    while (nextCap < needed) nextCap *= 2;
    const buffer = new ArrayBuffer(nextCap * GLYPH_INSTANCE_BYTES);
    const nextF32 = new Float32Array(buffer);
    nextF32.set(this.f32.subarray(0, this.count * GLYPH_INSTANCE_WORDS));
    this.f32 = nextF32;
    this.u32 = new Uint32Array(buffer);
    this.capacityGlyphs = nextCap;
  }

  addText(
    text: string,
    anchorX: number,
    yMid: number,
    fontSize: number,
    align: "left" | "center" | "right",
    colorPacked: number,
    clipArea: ChartArea,
  ): boolean {
    const len = text.length;
    if (len === 0 || !(fontSize > 0)) return true;

    const startCount = this.count;
    const adv = fontSize * this.advanceRatio;
    const totalW = len * adv;
    const cellScreen = (GLYPH_CELL_SIZE / GLYPH_FONT_PX) * fontSize;
    const halfCell = cellScreen * 0.5;
    const y = yMid - halfCell;
    const clipRight = clipArea.left + clipArea.width;
    const clipBottom = clipArea.top + clipArea.height;

    const verticalOut = y + cellScreen <= clipArea.top || y >= clipBottom;

    let startX: number;
    if (align === "left") startX = anchorX;
    else if (align === "center") startX = anchorX - totalW * 0.5;
    else startX = anchorX - totalW;

    this.ensureAdditionalCapacity(len);
    const packedColor = colorPacked >>> 0;

    for (let i = 0; i < len; i++) {
      const code = text.charCodeAt(i);
      const glyphIndex = code < 128 ? GLYPH_LOOKUP[code] : -1;
      if (glyphIndex < 0) {
        this.count = startCount;
        return false;
      }
      if (verticalOut || glyphIndex === SPACE_GLYPH_INDEX) continue;
      const charCenterX = startX + (i + 0.5) * adv;
      const x = charCenterX - halfCell;
      if (x + cellScreen <= clipArea.left || x >= clipRight) continue;

      const word = this.count * GLYPH_INSTANCE_WORDS;
      this.f32[word] = x;
      this.f32[word + 1] = y;
      this.f32[word + 2] = cellScreen;
      this.f32[word + 3] = cellScreen;
      this.u32[word + 4] = glyphIndex;
      this.u32[word + 5] = packedColor;
      this.count++;
    }
    return true;
  }
}

export class WebGpuNativeGlyphPipeline {
  readonly atlas: GlyphAtlasData;
  readonly pipeline: any;
  readonly uniformBuffer: any;
  readonly atlasTexture: any;
  readonly sampler: any;
  readonly bindGroup: any;
  private instanceBuffer: any;
  private instanceCapacityGlyphs: number;
  private readonly viewScratch = new Float32Array(8);
  private lastResW = Number.NaN;
  private lastResH = Number.NaN;
  private lastClipL = Number.NaN;
  private lastClipT = Number.NaN;
  private lastClipR = Number.NaN;
  private lastClipB = Number.NaN;
  private disposed = false;

  constructor(
    private readonly device: any,
    public readonly format: string,
    initialCapacityGlyphs = 4096,
  ) {
    if (
      !device
      || typeof device.createShaderModule !== "function"
      || typeof device.createTexture !== "function"
      || typeof device.createSampler !== "function"
      || typeof device.queue?.writeTexture !== "function"
    ) {
      throw new Error("WebGpuNativeGlyphPipeline: device lacks required WebGPU texture/sampler APIs");
    }

    this.instanceCapacityGlyphs = Math.max(256, initialCapacityGlyphs);
    this.atlas = getOrCreateGlyphAtlas();

    let uniformBuffer: any = null;
    let atlasTexture: any = null;
    let instanceBuffer: any = null;

    try {
      const shaderModule = device.createShaderModule({
        label: "NativeGlyphSdfShader",
        code: GLYPH_WGSL,
      });

      uniformBuffer = device.createBuffer({
        label: "NativeGlyphUniforms",
        size: 32, // resolution vec2 + pad vec2 + clipArea vec4
        usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
      });

      atlasTexture = device.createTexture({
        label: "NativeGlyphSdfAtlasTexture",
        size: [this.atlas.width, this.atlas.height, 1],
        format: "rgba8unorm",
        usage: 0x0004 | 0x0002, // TEXTURE_BINDING | COPY_DST
      });

      device.queue.writeTexture(
        { texture: atlasTexture },
        this.atlas.pixels,
        { bytesPerRow: this.atlas.width * 4, rowsPerImage: this.atlas.height },
        [this.atlas.width, this.atlas.height, 1],
      );

      const sampler = device.createSampler({
        label: "NativeGlyphSdfSampler",
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      const bindGroupLayout = device.createBindGroupLayout({
        label: "NativeGlyphBindGroupLayout",
        entries: [
          {
            binding: 0,
            visibility: 0x1 | 0x2, // VERTEX | FRAGMENT
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: 0x2, // FRAGMENT
            texture: { sampleType: "float" },
          },
          {
            binding: 2,
            visibility: 0x2, // FRAGMENT
            sampler: { type: "filtering" },
          },
        ],
      });

      const bindGroup = device.createBindGroup({
        label: "NativeGlyphBindGroup",
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: atlasTexture.createView() },
          { binding: 2, resource: sampler },
        ],
      });

      const pipelineLayout = device.createPipelineLayout({
        label: "NativeGlyphPipelineLayout",
        bindGroupLayouts: [bindGroupLayout],
      });

      const pipeline = device.createRenderPipeline({
        label: "NativeGlyphSdfRenderPipeline",
        layout: pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: "vs_main",
          buffers: [
            {
              arrayStride: GLYPH_INSTANCE_BYTES,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x4" },
                { shaderLocation: 1, offset: 16, format: "uint32" },
                { shaderLocation: 2, offset: 20, format: "uint32" },
              ],
            },
          ],
        },
        fragment: {
          module: shaderModule,
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
        primitive: {
          topology: "triangle-list",
        },
      });

      instanceBuffer = this.allocateInstanceBuffer(this.instanceCapacityGlyphs);

      this.uniformBuffer = uniformBuffer;
      this.atlasTexture = atlasTexture;
      this.sampler = sampler;
      this.bindGroup = bindGroup;
      this.pipeline = pipeline;
      this.instanceBuffer = instanceBuffer;
    } catch (err) {
      const destroyOnce = (resource: any): void => {
        if (!resource || typeof resource.destroy !== "function") return;
        try {
          resource.destroy();
        } catch {
          // Best-effort rollback on partial initialization failure.
        }
      };
      destroyOnce(instanceBuffer);
      destroyOnce(atlasTexture);
      destroyOnce(uniformBuffer);
      throw err;
    }
  }

  private allocateInstanceBuffer(glyphCount: number): any {
    return this.device.createBuffer({
      label: "NativeGlyphInstanceBuffer",
      size: glyphCount * GLYPH_INSTANCE_BYTES,
      usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
    });
  }

  updateView(width: number, height: number, clipArea: ChartArea): void {
    if (this.disposed) return;
    const resW = width > 0 ? width : 1;
    const resH = height > 0 ? height : 1;
    const clipL = clipArea.left;
    const clipT = clipArea.top;
    const clipR = clipArea.left + clipArea.width;
    const clipB = clipArea.top + clipArea.height;
    if (
      resW === this.lastResW
      && resH === this.lastResH
      && clipL === this.lastClipL
      && clipT === this.lastClipT
      && clipR === this.lastClipR
      && clipB === this.lastClipB
    ) {
      return;
    }
    this.lastResW = resW;
    this.lastResH = resH;
    this.lastClipL = clipL;
    this.lastClipT = clipT;
    this.lastClipR = clipR;
    this.lastClipB = clipB;

    this.viewScratch[0] = resW;
    this.viewScratch[1] = resH;
    this.viewScratch[2] = 0;
    this.viewScratch[3] = 0;
    this.viewScratch[4] = clipL;
    this.viewScratch[5] = clipT;
    this.viewScratch[6] = clipR;
    this.viewScratch[7] = clipB;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.viewScratch);
  }

  uploadInstances(sink: WebGpuGlyphSink): void {
    const count = sink.count;
    if (this.disposed || count <= 0) return;
    if (count > this.instanceCapacityGlyphs) {
      this.instanceBuffer?.destroy?.();
      this.instanceCapacityGlyphs = Math.max(count, this.instanceCapacityGlyphs * 2);
      this.instanceBuffer = this.allocateInstanceBuffer(this.instanceCapacityGlyphs);
    }
    const byteLength = count * GLYPH_INSTANCE_BYTES;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      sink.f32.buffer,
      0,
      byteLength,
    );
    incrementPerformanceCounter("gpu.upload.bytes", byteLength);
    incrementPerformanceCounter("gpu.native.upload.glyphBytes", byteLength);
  }

  recordPass(passEncoder: any, instanceCount: number): void {
    if (this.disposed || instanceCount <= 0) return;
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.instanceBuffer);
    passEncoder.draw(6, instanceCount, 0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.uniformBuffer?.destroy?.();
      this.instanceBuffer?.destroy?.();
      this.atlasTexture?.destroy?.();
    } catch {
      // Mock safety
    }
  }
}
