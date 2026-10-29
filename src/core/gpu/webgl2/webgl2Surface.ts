import { QuadBatch } from "../../engine/quadBatch.js";
import type { GpuFrame, GpuLossReason, GpuSurface, HeatmapLayer, RGBA, RgbaFrame } from "../gpuBackend.js";

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

export class WebGl2Surface implements GpuSurface {
  readonly kind = "webgl2" as const;
  readonly heatmap: HeatmapLayer | null = null;

  private batch: QuadBatch;
  private dpr = 1;
  private disposed = false;
  private readonly lostListeners = new Set<(reason: GpuLossReason) => void>();
  private readonly unbindLoss: () => void;

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    batch?: QuadBatch,
  ) {
    this.batch = batch ?? new QuadBatch(gl);

    const onLost = (e: Event): void => {
      e.preventDefault();
      for (const listener of [...this.lostListeners]) {
        try {
          listener("context-lost");
        } catch (err) {
          console.error("[WebGl2Surface] onLost listener error", err);
        }
      }
    };

    canvas.addEventListener?.("webglcontextlost", onLost);
    this.unbindLoss = () => {
      canvas.removeEventListener?.("webglcontextlost", onLost);
    };
  }

  getGlContext(): WebGL2RenderingContext {
    return this.gl;
  }

  getBatch(): QuadBatch {
    return this.batch;
  }

  updateGl(nextGl: WebGL2RenderingContext): void {
    if (this.disposed) return;
    this.gl = nextGl;
    this.batch.dispose();
    this.batch = new QuadBatch(nextGl);
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
    gl.viewport(0, 0, width, height);
    gl.clearColor(clear.r, clear.g, clear.b, clear.a);
    gl.clear(gl.COLOR_BUFFER_BIT);

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
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindLoss();
    this.lostListeners.clear();
    this.batch.dispose();
  }
}
