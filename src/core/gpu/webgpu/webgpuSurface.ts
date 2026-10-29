import type {
  GpuFrame,
  GpuLossReason,
  GpuSurface,
  HeatmapLayer,
  QuadSink,
  RGBA,
  RgbaFrame,
} from "../gpuBackend.js";
import type { WebGpuDeviceHandle } from "./webgpuDevice.js";
import { WebGpuQuadPipeline } from "./webgpuQuadPipeline.js";

export class WebGpuQuadSink implements QuadSink {
  data: Float32Array;
  count = 0;

  constructor(initialCapacity = 10000) {
    this.data = new Float32Array(initialCapacity * 8);
  }

  reset(): void {
    this.count = 0;
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const requiredLength = (this.count + 1) * 8;
    if (requiredLength > this.data.length) {
      const next = new Float32Array(Math.max(requiredLength, this.data.length * 2));
      next.set(this.data);
      this.data = next;
    }
    const offset = this.count * 8;
    this.data[offset] = x;
    this.data[offset + 1] = y;
    this.data[offset + 2] = w;
    this.data[offset + 3] = h;
    this.data[offset + 4] = c.r;
    this.data[offset + 5] = c.g;
    this.data[offset + 6] = c.b;
    this.data[offset + 7] = c.a;
    this.count++;
  }
}

export class WebGpuSurface implements GpuSurface {
  readonly kind = "webgpu" as const;
  readonly heatmap: HeatmapLayer | null = null;

  private readonly ctx: any;
  private readonly pipeline: WebGpuQuadPipeline;
  private readonly quadSink = new WebGpuQuadSink();
  private dpr = 1;
  private disposed = false;
  private lastRenderedTexture: any = null;
  private readonly lostListeners = new Set<(reason: GpuLossReason) => void>();
  private readonly unbindDeviceLoss: () => void;

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private readonly handle: WebGpuDeviceHandle,
    pipeline?: WebGpuQuadPipeline,
  ) {
    this.ctx = canvas.getContext ? canvas.getContext("webgpu") : null;
    if (this.ctx && typeof this.ctx.configure === "function") {
      this.ctx.configure({
        device: handle.device,
        format: handle.format,
        alphaMode: "premultiplied",
        usage: 0x0010 | 0x0001, // GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
      });
    }

    this.pipeline = pipeline ?? new WebGpuQuadPipeline(handle.device, handle.format);

    this.unbindDeviceLoss = handle.onLost((reason) => {
      const mappedReason: GpuLossReason = reason === "validation-failed" ? "validation-failed" : "device-lost";
      for (const listener of [...this.lostListeners]) {
        try {
          listener(mappedReason);
        } catch (err) {
          console.error("[WebGpuSurface] onLost listener error", err);
        }
      }
    });
  }

  getDeviceHandle(): WebGpuDeviceHandle {
    return this.handle;
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

    this.quadSink.reset();
    let currentTexture: any = null;
    try {
      currentTexture = this.ctx?.getCurrentTexture?.();
      this.lastRenderedTexture = currentTexture;
    } catch {
      // Mock / headless safety
    }

    return {
      quads: this.quadSink,
      flushQuads: (logicalWidth?: number, logicalHeight?: number) => {
        if (this.disposed) return;
        const w = logicalWidth ?? (this.canvas.width / this.dpr);
        const h = logicalHeight ?? (this.canvas.height / this.dpr);
        const count = this.quadSink.count;

        const device = this.handle.device;
        if (!device || !currentTexture) return;

        const commandEncoder = device.createCommandEncoder({
          label: "WebGpuFrameCommandEncoder",
        });

        const passEncoder = commandEncoder.beginRenderPass({
          label: "WebGpuFrameRenderPass",
          colorAttachments: [
            {
              view: currentTexture.createView ? currentTexture.createView() : currentTexture,
              clearValue: { r: clear.r, g: clear.g, b: clear.b, a: clear.a },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });

        if (count > 0) {
          this.pipeline.updateResolution(w, h);
          this.pipeline.uploadInstances(this.quadSink.data, count);
          this.pipeline.recordPass(passEncoder, count);
        }

        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
      },
      end: () => {},
    };
  }

  async requestCapture(): Promise<RgbaFrame> {
    if (this.disposed) {
      throw new Error("WebGpuSurface: cannot capture disposed surface");
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width <= 0 || height <= 0) {
      throw new Error("WebGpuSurface: invalid canvas dimensions for capture");
    }

    const device = this.handle.device;
    const texture = this.lastRenderedTexture ?? this.ctx?.getCurrentTexture?.();
    if (!device || !texture) {
      throw new Error("WebGpuSurface: texture unavailable for capture");
    }

    const bytesPerPixel = 4;
    const unpaddedBytesPerRow = width * bytesPerPixel;
    const align = 256;
    const bytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;
    const bufferSize = bytesPerRow * height;

    const stagingBuffer = device.createBuffer({
      label: "WebGpuCaptureStagingBuffer",
      size: bufferSize,
      usage: 0x0008 | 0x0001, // GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    const commandEncoder = device.createCommandEncoder({
      label: "WebGpuCaptureCommandEncoder",
    });

    commandEncoder.copyTextureToBuffer(
      { texture },
      {
        buffer: stagingBuffer,
        bytesPerRow,
        rowsPerImage: height,
      },
      {
        width,
        height,
        depthOrArrayLayers: 1,
      },
    );

    device.queue.submit([commandEncoder.finish()]);

    await stagingBuffer.mapAsync(0x0001); // GPUMapMode.READ
    const mapped = new Uint8Array(stagingBuffer.getMappedRange());
    const out = new Uint8ClampedArray(width * height * 4);
    const isBgra = this.handle.format === "bgra8unorm";

    for (let row = 0; row < height; row++) {
      const srcRowOffset = row * bytesPerRow;
      const dstRowOffset = row * unpaddedBytesPerRow;

      if (isBgra) {
        for (let x = 0; x < width; x++) {
          const srcPixel = srcRowOffset + x * 4;
          const dstPixel = dstRowOffset + x * 4;
          const b = mapped[srcPixel];
          const g = mapped[srcPixel + 1];
          const r = mapped[srcPixel + 2];
          const a = mapped[srcPixel + 3];
          out[dstPixel] = r;
          out[dstPixel + 1] = g;
          out[dstPixel + 2] = b;
          out[dstPixel + 3] = a;
        }
      } else {
        out.set(
          mapped.subarray(srcRowOffset, srcRowOffset + unpaddedBytesPerRow),
          dstRowOffset,
        );
      }
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return {
      data: out,
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
    this.unbindDeviceLoss();
    this.lostListeners.clear();
    this.pipeline.dispose();
  }
}
