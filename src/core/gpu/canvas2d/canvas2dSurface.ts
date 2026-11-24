import type { GpuFrame, GpuLossReason, GpuSurface, QuadSink, RGBA, RgbaFrame } from "../gpuBackend.js";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const RGBA_CACHE = new Map<number, string>();

function packRgbaKey(rByte: number, gByte: number, bByte: number, aByte: number): number {
  return (rByte | (gByte << 8) | (bByte << 16) | (aByte << 24)) >>> 0;
}

function getCssRgbaFromBytes(rByte: number, gByte: number, bByte: number, rawAlpha: number, key: number): string {
  let css = RGBA_CACHE.get(key);
  if (css !== undefined) return css;
  const aNorm = Number(clamp01(rawAlpha).toFixed(3));
  css = `rgba(${rByte}, ${gByte}, ${bByte}, ${aNorm})`;
  if (RGBA_CACHE.size >= 4096) RGBA_CACHE.clear();
  RGBA_CACHE.set(key, css);
  return css;
}

function formatCssRgba(c: RGBA): string {
  const rByte = (clamp01(c.r) * 255 + 0.5) | 0;
  const gByte = (clamp01(c.g) * 255 + 0.5) | 0;
  const bByte = (clamp01(c.b) * 255 + 0.5) | 0;
  const aByte = (clamp01(c.a) * 255 + 0.5) | 0;
  return getCssRgbaFromBytes(rByte, gByte, bByte, c.a, packRgbaKey(rByte, gByte, bByte, aByte));
}

export class Canvas2dQuadSink implements QuadSink {
  private lastKey = -1;

  constructor(private ctx: CanvasRenderingContext2D) {}

  updateContext(nextCtx: CanvasRenderingContext2D): void {
    this.ctx = nextCtx;
    this.reset();
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const rByte = (clamp01(c.r) * 255 + 0.5) | 0;
    const gByte = (clamp01(c.g) * 255 + 0.5) | 0;
    const bByte = (clamp01(c.b) * 255 + 0.5) | 0;
    const aByte = (clamp01(c.a) * 255 + 0.5) | 0;
    const key = packRgbaKey(rByte, gByte, bByte, aByte);
    if (this.lastKey !== key) {
      this.ctx.fillStyle = getCssRgbaFromBytes(rByte, gByte, bByte, c.a, key);
      this.lastKey = key;
    }
    this.ctx.fillRect(x, y, w, h);
  }

  reset(): void {
    this.lastKey = -1;
  }
}

export class Canvas2dSurface implements GpuSurface {
  readonly kind = "canvas2d" as const;

  private readonly quadSink: Canvas2dQuadSink;
  private dpr = 1;
  private disposed = false;
  private inFrame = false;
  private contextLost = false;
  private readonly lostListeners = new Set<(reason: GpuLossReason) => void>();
  private contextLostBound = false;

  private readonly handleContextLost = (_e: Event): void => {
    this.contextLost = true;
    for (const listener of [...this.lostListeners]) {
      try {
        listener("context-lost");
      } catch (err) {
        console.error("[Canvas2dSurface] onLost listener error", err);
      }
    }
  };

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D = canvas.getContext("2d") as CanvasRenderingContext2D,
  ) {
    if (!this.ctx) {
      throw new Error("Canvas2dSurface: failed to acquire 2D rendering context");
    }
    this.quadSink = new Canvas2dQuadSink(this.ctx);
  }

  markContextLost(): void {
    this.contextLost = true;
  }

  restoreCanvas2dContext(nextCtx?: CanvasRenderingContext2D | null): boolean {
    if (this.disposed) return false;
    const resolved = nextCtx !== undefined ? nextCtx : (this.canvas.getContext?.("2d") as CanvasRenderingContext2D | null);
    if (!resolved || resolved.isContextLost?.() === true) {
      return false;
    }
    this.ctx = resolved;
    this.quadSink.updateContext(resolved);
    this.inFrame = false;
    this.contextLost = false;
    return true;
  }

  resize(bitmapWidth: number, bitmapHeight: number, dpr = 1): void {
    if (this.disposed) return;
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    this.dpr = dpr > 0 ? dpr : 1;
  }

  beginFrame(clear: RGBA): GpuFrame {
    if (this.disposed || this.contextLost) {
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
    if (this.contextLost || this.ctx.isContextLost?.() === true) {
      throw new Error("Canvas2dSurface: context is lost");
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

  onLost(listener: (reason: GpuLossReason) => void): () => void {
    if (this.disposed) return () => {};
    if (!this.contextLostBound && this.canvas.addEventListener) {
      this.canvas.addEventListener("contextlost", this.handleContextLost);
      this.contextLostBound = true;
    }
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
      if (this.lostListeners.size === 0 && this.contextLostBound && this.canvas.removeEventListener) {
        this.canvas.removeEventListener("contextlost", this.handleContextLost);
        this.contextLostBound = false;
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.contextLostBound && this.canvas.removeEventListener) {
      this.canvas.removeEventListener("contextlost", this.handleContextLost);
      this.contextLostBound = false;
    }
    this.lostListeners.clear();
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
