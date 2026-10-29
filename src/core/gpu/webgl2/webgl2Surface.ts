import { QuadBatch } from "../../engine/quadBatch.js";
import type { GpuFrame, GpuLossReason, GpuSurface, HeatmapLayer, QuadSink, RGBA, RgbaFrame } from "../gpuBackend.js";

function flipRgba(source: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const rowBytes = width * 4;
  const expected = rowBytes * height;
  const output = new Uint8ClampedArray(expected);
  for (let sourceRow = 0; sourceRow < height; sourceRow++) {
    const targetRow = height - 1 - sourceRow;
    output.set(source.subarray(sourceRow * rowBytes, (sourceRow + 1) * rowBytes), targetRow * rowBytes);
  }
  return output;
}

function makeNoopBatch(): QuadSink & { begin(): void; flush(): void; dispose(): void } {
  return {
    begin() {},
    rect() {},
    flush() {},
    dispose() {},
  };
}

export class WebGl2Surface implements GpuSurface {
  readonly kind = "webgl2" as const;
  readonly heatmap: HeatmapLayer | null = null;

  private batch: QuadSink & { begin(): void; flush(w: number, h: number): void; dispose(): void };
  private dpr = 1;
  private disposed = false;
  private readonly lostListeners = new Set<(reason: GpuLossReason) => void>();
  private contextLostBound = false;

  private readonly handleContextLost = (e: Event): void => {
    e.preventDefault();
    for (const listener of [...this.lostListeners]) {
      try {
        listener("context-lost");
      } catch (err) {
        console.error("[WebGl2Surface] onLost listener error", err);
      }
    }
  };

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    batch?: QuadBatch,
  ) {
    const canCreateBatch = Boolean(
      gl
      && typeof gl.createVertexArray === "function"
      && typeof gl.createProgram === "function"
    );
    this.batch = batch ?? (canCreateBatch ? new QuadBatch(gl) : makeNoopBatch());
  }

  getGlContext(): WebGL2RenderingContext {
    return this.gl;
  }

  getBatch(): QuadSink {
    return this.batch;
  }

  updateGl(nextGl: WebGL2RenderingContext): void {
    if (this.disposed) return;
    this.gl = nextGl;
    this.batch.dispose();
    const canCreateBatch = Boolean(
      nextGl
      && typeof nextGl.createVertexArray === "function"
      && typeof nextGl.createProgram === "function"
    );
    this.batch = canCreateBatch ? new QuadBatch(nextGl) : makeNoopBatch();
  }

  resize(bitmapWidth: number, bitmapHeight: number, dpr = 1): void {
    if (this.disposed) return;
    this.canvas.width = bitmapWidth;
    this.canvas.height = bitmapHeight;
    this.dpr = dpr > 0 ? dpr : 1;
    this.gl.viewport?.(0, 0, bitmapWidth, bitmapHeight);
  }

  beginFrame(clear: RGBA): GpuFrame {
    if (this.disposed) {
      return {
        quads: this.batch,
        flushQuads: () => {},
        end: () => {},
      };
    }

    const gl = this.gl;
    const width = gl.drawingBufferWidth ?? this.canvas.width;
    const height = gl.drawingBufferHeight ?? this.canvas.height;
    gl.viewport?.(0, 0, width, height);
    gl.clearColor?.(clear.r, clear.g, clear.b, clear.a);
    gl.clear?.(gl.COLOR_BUFFER_BIT);

    this.batch.begin();

    return {
      quads: this.batch,
      flushQuads: () => {
        if (this.disposed) return;
        this.batch.flush(this.canvas.width / this.dpr, this.canvas.height / this.dpr);
      },
      end: () => {},
    };
  }

  async requestCapture(): Promise<RgbaFrame> {
    if (this.disposed) {
      throw new Error("WebGl2Surface: cannot capture disposed surface");
    }
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) {
      throw new Error("WebGl2Surface: invalid canvas dimensions for capture");
    }

    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const flipped = flipRgba(raw, width, height);
    return {
      data: flipped,
      width,
      height,
    };
  }

  onLost(listener: (reason: GpuLossReason) => void): () => void {
    if (this.disposed) return () => {};
    if (!this.contextLostBound && this.canvas.addEventListener) {
      this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
      this.contextLostBound = true;
    }
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
      if (this.lostListeners.size === 0 && this.contextLostBound && this.canvas.removeEventListener) {
        this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
        this.contextLostBound = false;
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.contextLostBound && this.canvas.removeEventListener) {
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      this.contextLostBound = false;
    }
    this.lostListeners.clear();
    this.batch.dispose();
  }
}
