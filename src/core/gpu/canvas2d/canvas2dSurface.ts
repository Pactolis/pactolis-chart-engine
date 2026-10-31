import type { GpuFrame, GpuLossReason, GpuSurface, HeatmapLayer, QuadSink, RGBA, RgbaFrame } from "../gpuBackend.js";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const RGBA_CACHE = new Map<number, string>();

function formatCssRgba(c: RGBA): string {
  const rByte = Math.round(clamp01(c.r) * 255);
  const gByte = Math.round(clamp01(c.g) * 255);
  const bByte = Math.round(clamp01(c.b) * 255);
  const aNorm = Number(clamp01(c.a).toFixed(3));
  const aByte = Math.round(aNorm * 255);
  const key = (rByte | (gByte << 8) | (bByte << 16) | (aByte << 24)) >>> 0;
  let css = RGBA_CACHE.get(key);
  if (css !== undefined) return css;
  css = `rgba(${rByte}, ${gByte}, ${bByte}, ${aNorm})`;
  if (RGBA_CACHE.size >= 4096) RGBA_CACHE.clear();
  RGBA_CACHE.set(key, css);
  return css;
}

export class Canvas2dQuadSink implements QuadSink {
  private lastCss = "";

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const css = formatCssRgba(c);
    if (this.lastCss !== css) {
      this.ctx.fillStyle = css;
      this.lastCss = css;
    }
    this.ctx.fillRect(x, y, w, h);
  }

  reset(): void {
    this.lastCss = "";
  }
}

export class Canvas2dSurface implements GpuSurface {
  readonly kind = "canvas2d" as const;
  readonly heatmap: HeatmapLayer | null = null;

  private readonly quadSink: Canvas2dQuadSink;
  private dpr = 1;
  private disposed = false;
  private inFrame = false;

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D = canvas.getContext("2d") as CanvasRenderingContext2D,
  ) {
    if (!this.ctx) {
      throw new Error("Canvas2dSurface: failed to acquire 2D rendering context");
    }
    this.quadSink = new Canvas2dQuadSink(this.ctx);
  }

  resize(bitmapWidth: number, bitmapHeight: number, dpr = 1): void {
    if (this.disposed) return;
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    this.dpr = dpr > 0 ? dpr : 1;
  }

  beginFrame(clear: RGBA): GpuFrame {
    if (this.disposed) {
      return {
        quads: this.quadSink,
        flushQuads: () => {},
        end: () => {},
      };
    }

    this.inFrame = true;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const cssClear = formatCssRgba(clear);
    ctx.fillStyle = cssClear;
    ctx.fillRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    this.quadSink.reset();

    return {
      quads: this.quadSink,
      flushQuads: () => {},
      end: () => {
        if (!this.inFrame) return;
        this.inFrame = false;
        ctx.restore();
      },
    };
  }

  async requestCapture(): Promise<RgbaFrame> {
    if (this.disposed) {
      throw new Error("Canvas2dSurface: cannot capture disposed surface");
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) {
      throw new Error("Canvas2dSurface: invalid canvas dimensions for capture");
    }
    const imgData = this.ctx.getImageData(0, 0, width, height);
    return {
      data: imgData.data,
      width,
      height,
    };
  }

  onLost(_listener: (reason: GpuLossReason) => void): () => void {
    // 2D canvas contexts do not experience context-loss in HTML5 specifications.
    return () => {};
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFrame) {
      this.inFrame = false;
      try {
        this.ctx.restore();
      } catch {
        // ignore
      }
    }
  }
}
