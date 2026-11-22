import type {
  GpuFrame,
  GpuLossReason,
  GpuNativeHeatmapFrame,
  GpuNativeHeatmapPlot,
  GpuNativeSceneInput,
  GpuSurface,
  QuadSink,
  RGBA,
  RgbaFrame,
} from "../gpuBackend.js";
import type { WebGpuDeviceHandle } from "./webgpuDevice.js";
import { WebGpuNativeHeatmapPipeline } from "./webgpuNativeHeatmapPipeline.js";
import { WebGpuNativeScenePipeline } from "./webgpuNativeScenePipeline.js";
import { WebGpuQuadPipeline } from "./webgpuQuadPipeline.js";

export class WebGpuQuadSink implements QuadSink {
  data: Float32Array;
  count = 0;
  private colorBytes: Uint8Array;

  constructor(initialCapacity = 10000) {
    this.data = new Float32Array(initialCapacity * 5);
    this.colorBytes = new Uint8Array(this.data.buffer);
  }

  reset(): void {
    this.count = 0;
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    const requiredLength = (this.count + 1) * 5;
    if (requiredLength > this.data.length) {
      const next = new Float32Array(Math.max(requiredLength, this.data.length * 2));
      next.set(this.data);
      this.data = next;
      this.colorBytes = new Uint8Array(next.buffer);
    }
    const offset = this.count * 5;
    this.data[offset] = x;
    this.data[offset + 1] = y;
    this.data[offset + 2] = w;
    this.data[offset + 3] = h;
    const colorOffset = (offset + 4) * 4;
    this.colorBytes[colorOffset] = Math.round(Math.min(1, Math.max(0, c.r)) * 255);
    this.colorBytes[colorOffset + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255);
    this.colorBytes[colorOffset + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255);
    this.colorBytes[colorOffset + 3] = Math.round(Math.min(1, Math.max(0, c.a)) * 255);
    this.count++;
  }
}

export class WebGpuSurface implements GpuSurface {
  readonly kind = "webgpu" as const;

  private readonly ctx: any;
  private readonly pipeline: WebGpuQuadPipeline;
  private nativePipeline: WebGpuNativeScenePipeline | null = null;
  private nativeSceneDisabled = false;
  private nativeHeatmapPipeline: WebGpuNativeHeatmapPipeline | null = null;
  private nativeHeatmapDisabled = false;
  private readonly quadSink = new WebGpuQuadSink();
  private dpr = 1;
  private disposed = false;
  private lastRenderedTexture: any = null;
  private readonly lostListeners = new Set<(reason: GpuLossReason) => void>();
  private readonly captureAbortListeners = new Set<() => void>();
  private readonly unbindDeviceLoss: () => void;
  private initVerificationPromise: Promise<void> | null = null;

  constructor(
    public readonly canvas: HTMLCanvasElement,
    private readonly handle: WebGpuDeviceHandle,
    pipeline?: WebGpuQuadPipeline,
  ) {
    this.ctx = canvas.getContext ? canvas.getContext("webgpu") : null;
    const device = handle.device;
    const hasErrorScope =
      !pipeline
      && typeof device?.pushErrorScope === "function"
      && typeof device?.popErrorScope === "function";

    let pushedScopes = 0;
    if (hasErrorScope) {
      try {
        device.pushErrorScope("out-of-memory");
        pushedScopes++;
        device.pushErrorScope("validation");
        pushedScopes++;
      } catch {
        while (pushedScopes > 0) {
          pushedScopes--;
          try { Promise.resolve(device.popErrorScope()).catch(() => {}); } catch {}
        }
      }
    }

    try {
      if (this.ctx && typeof this.ctx.configure === "function") {
        this.ctx.configure({
          device,
          format: handle.format,
          alphaMode: "premultiplied",
          usage: 0x0010 | 0x0001, // GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });
      }

      this.pipeline = pipeline ?? new WebGpuQuadPipeline(device, handle.format);
    } finally {
      if (pushedScopes > 0) {
        const pops: Array<Promise<any>> = [];
        while (pushedScopes > 0) {
          pushedScopes--;
          try {
            pops.push(Promise.resolve(device.popErrorScope()).catch(() => null));
          } catch {
            pops.push(Promise.resolve(null));
          }
        }
        this.initVerificationPromise = Promise.all(pops).then((errors) => {
          const err = errors.find((item) => item != null);
          if (err) {
            throw new Error(`WebGpuSurface init failed: ${err.message ?? String(err)}`);
          }
        });
        this.initVerificationPromise.catch(() => {});
      }
    }

    this.unbindDeviceLoss = handle.onLost((reason) => {
      const mappedReason: GpuLossReason =
        reason === "out-of-memory"
          ? "out-of-memory"
          : reason === "internal-error"
            ? "internal-error"
            : reason === "validation-failed"
              ? "validation-failed"
              : "device-lost";
      for (const listener of [...this.lostListeners]) {
        try {
          listener(mappedReason);
        } catch (err) {
          console.error("[WebGpuSurface] onLost listener error", err);
        }
      }
    });
  }

  async verifyInit(): Promise<void> {
    if (this.initVerificationPromise) {
      await this.initVerificationPromise;
    }
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

  supportsNativeScene(): boolean {
    if (this.disposed || this.nativeSceneDisabled || this.handle.isLost()) return false;
    const device = this.handle.device;
    return Boolean(
      device
      && typeof device.createComputePipeline === "function"
      && typeof device.createRenderPipeline === "function",
    );
  }

  renderNativeScene(
    clear: RGBA,
    logicalWidth: number,
    logicalHeight: number,
    scene: GpuNativeSceneInput,
  ): boolean {
    if (!this.supportsNativeScene()) return false;
    const device = this.handle.device;
    if (!device) return false;

    if (!this.nativePipeline) {
      try {
        this.nativePipeline = new WebGpuNativeScenePipeline(device, this.handle.format, {
          supportsTimestampQuery: this.handle.supportsTimestampQuery,
          maxBufferSize: this.handle.limits?.maxBufferSize,
        });
      } catch {
        this.nativeSceneDisabled = true;
        return false;
      }
    }

    let currentTexture: any = null;
    try {
      currentTexture = this.ctx?.getCurrentTexture?.();
      this.lastRenderedTexture = currentTexture;
    } catch {
      currentTexture = null;
    }
    if (!currentTexture) return false;

    const w = logicalWidth > 0 ? logicalWidth : (this.canvas.width / this.dpr);
    const h = logicalHeight > 0 ? logicalHeight : (this.canvas.height / this.dpr);
    const prepared = this.nativePipeline.prepareFrame(scene, w, h);
    if (!prepared.ok) return false;

    this.quadSink.reset();
    if (scene.drawGrid && scene.drawGridQuads) {
      scene.drawGridQuads(this.quadSink);
    }
    const gridCount = this.quadSink.count;
    if (scene.drawForegroundOverlay) {
      scene.drawForegroundOverlay(this.quadSink);
    }
    const totalOverlayQuads = this.quadSink.count;
    const fgCount = totalOverlayQuads - gridCount;

    if (totalOverlayQuads > 0) {
      this.pipeline.updateResolution(w, h);
      this.pipeline.uploadInstances(this.quadSink.data, totalOverlayQuads);
    }

    const commandEncoder = device.createCommandEncoder({
      label: "WebGpuNativeSceneCommandEncoder",
    });

    const tsSlot = this.nativePipeline.beginTimestampPass();
    const ranCompute = this.nativePipeline.needsComputeDispatch();
    if (ranCompute) {
      this.nativePipeline.recordComputePass(commandEncoder, tsSlot);
    }

    const passEncoder = commandEncoder.beginRenderPass({
      label: "WebGpuNativeSceneRenderPass",
      colorAttachments: [
        {
          view: currentTexture.createView ? currentTexture.createView() : currentTexture,
          clearValue: { r: clear.r, g: clear.g, b: clear.b, a: clear.a },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      ...(tsSlot !== null ? { timestampWrites: this.nativePipeline.timestampWritesFor(tsSlot) } : {}),
    });

    if (gridCount > 0) {
      this.pipeline.recordPass(passEncoder, gridCount, 0);
    }
    this.nativePipeline.recordRenderPasses(passEncoder, scene, prepared);
    if (fgCount > 0) {
      this.pipeline.recordPass(passEncoder, fgCount, gridCount);
    }

    passEncoder.end();
    if (tsSlot !== null) {
      this.nativePipeline.resolveTimestampPass(commandEncoder, tsSlot, ranCompute);
    }
    device.queue.submit([commandEncoder.finish()]);
    if (tsSlot !== null) {
      this.nativePipeline.readbackTimestampPass(tsSlot, ranCompute);
    }
    return true;
  }

  readNativeVisiblePriceRangeAsync(
    series: any,
    visibleFrom: number,
    visibleTo: number,
  ): Promise<{ min: number; max: number } | null> {
    if (!this.supportsNativeScene()) return Promise.resolve(null);
    if (!this.nativePipeline) {
      try {
        this.nativePipeline = new WebGpuNativeScenePipeline(this.handle.device, this.handle.format, {
          supportsTimestampQuery: this.handle.supportsTimestampQuery,
          maxBufferSize: this.handle.limits?.maxBufferSize,
        });
      } catch {
        this.nativeSceneDisabled = true;
        return Promise.resolve(null);
      }
    }
    return this.nativePipeline.readVisiblePriceRangeAsync(series, visibleFrom, visibleTo);
  }

  supportsNativeHeatmap(): boolean {
    if (this.disposed || this.nativeHeatmapDisabled || this.handle.isLost()) return false;
    const device = this.handle.device;
    return Boolean(device && typeof device.createRenderPipeline === "function");
  }

  private ensureNativeHeatmapPipeline(): WebGpuNativeHeatmapPipeline | null {
    if (!this.supportsNativeHeatmap()) return null;
    if (!this.nativeHeatmapPipeline) {
      try {
        this.nativeHeatmapPipeline = new WebGpuNativeHeatmapPipeline(
          this.handle.device,
          this.handle.format,
          this.handle.limits?.maxBufferSize,
        );
      } catch {
        this.nativeHeatmapDisabled = true;
        return null;
      }
    }
    return this.nativeHeatmapPipeline;
  }

  reserveNativeHeatmapPayload(logicalBytes: number): { release(): void } | null {
    const pipeline = this.ensureNativeHeatmapPipeline();
    if (!pipeline) return null;
    return pipeline.reservePreparedPayload(logicalBytes);
  }

  renderNativeHeatmap(frame: GpuNativeHeatmapFrame, plot: GpuNativeHeatmapPlot): boolean {
    const pipeline = this.ensureNativeHeatmapPipeline();
    if (!pipeline) return false;

    let targetTexture = this.lastRenderedTexture;
    if (!targetTexture) {
      try {
        targetTexture = this.ctx?.getCurrentTexture?.();
        this.lastRenderedTexture = targetTexture;
      } catch {
        targetTexture = null;
      }
    }
    if (!targetTexture) return false;

    const ok = pipeline.renderFrame(
      targetTexture,
      this.canvas.width,
      this.canvas.height,
      this.dpr,
      frame,
      plot,
    );
    if (!ok) {
      this.disposeNativeHeatmap();
      this.nativeHeatmapDisabled = true;
    }
    return ok;
  }

  disposeNativeHeatmap(): void {
    this.nativeHeatmapPipeline?.dispose();
    this.nativeHeatmapPipeline = null;
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
    if (this.handle.isLost()) {
      throw new Error("WebGpuSurface: device is lost");
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

    const hasErrorScope =
      typeof device.pushErrorScope === "function"
      && typeof device.popErrorScope === "function";

    let stagingBuffer: any = null;
    let mapped = false;
    let unbindLost: (() => void) | null = null;
    let unbindAbort: (() => void) | null = null;
    let pushedScopes = 0;

    try {
      if (hasErrorScope) {
        try {
          device.pushErrorScope("out-of-memory");
          pushedScopes++;
          device.pushErrorScope("validation");
          pushedScopes++;
        } catch {
          while (pushedScopes > 0) {
            pushedScopes--;
            try { Promise.resolve(device.popErrorScope()).catch(() => {}); } catch {}
          }
        }
      }

      const scopePops: Array<Promise<any>> = [];
      try {
        stagingBuffer = device.createBuffer({
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
      } finally {
        while (pushedScopes > 0) {
          pushedScopes--;
          try {
            scopePops.push(Promise.resolve(device.popErrorScope()).catch(() => null));
          } catch {
            scopePops.push(Promise.resolve(null));
          }
        }
      }

      if (scopePops.length > 0) {
        const errors = await Promise.all(scopePops);
        const scopeErr = errors.find((item) => item != null);
        if (scopeErr) {
          throw new Error(`WebGpuSurface capture failed: ${scopeErr.message ?? String(scopeErr)}`);
        }
      }

      if (this.disposed) {
        throw new Error("WebGpuSurface: disposed during capture");
      }
      if (this.handle.isLost()) {
        throw new Error("WebGpuSurface: device lost during capture");
      }

      const mapPromise = Promise.resolve(stagingBuffer.mapAsync(0x0001)); // GPUMapMode.READ
      void mapPromise.catch(() => {});
      const lostPromise = new Promise<never>((_, reject) => {
        unbindLost = this.handle.onLost((reason) => {
          reject(new Error(`WebGpuSurface: device lost during capture (${reason})`));
        });
      });
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          reject(new Error("WebGpuSurface: disposed during capture"));
        };
        this.captureAbortListeners.add(onAbort);
        unbindAbort = () => {
          this.captureAbortListeners.delete(onAbort);
        };
        if (this.disposed) {
          onAbort();
        }
      });

      await Promise.race([mapPromise, lostPromise, abortPromise]);
      if (this.disposed) {
        throw new Error("WebGpuSurface: disposed during capture");
      }
      mapped = true;

      const mappedBytes = new Uint8Array(stagingBuffer.getMappedRange());
      const out = new Uint8ClampedArray(width * height * 4);
      const isBgra = this.handle.format === "bgra8unorm";

      for (let row = 0; row < height; row++) {
        const srcRowOffset = row * bytesPerRow;
        const dstRowOffset = row * unpaddedBytesPerRow;

        if (isBgra) {
          for (let x = 0; x < width; x++) {
            const srcPixel = srcRowOffset + x * 4;
            const dstPixel = dstRowOffset + x * 4;
            const b = mappedBytes[srcPixel];
            const g = mappedBytes[srcPixel + 1];
            const r = mappedBytes[srcPixel + 2];
            const a = mappedBytes[srcPixel + 3];
            out[dstPixel] = r;
            out[dstPixel + 1] = g;
            out[dstPixel + 2] = b;
            out[dstPixel + 3] = a;
          }
        } else {
          out.set(
            mappedBytes.subarray(srcRowOffset, srcRowOffset + unpaddedBytesPerRow),
            dstRowOffset,
          );
        }
      }

      return {
        data: out,
        width,
        height,
      };
    } finally {
      if (unbindAbort) {
        try { unbindAbort(); } catch {}
      }
      if (unbindLost) {
        try { unbindLost(); } catch {}
      }
      if (mapped && stagingBuffer) {
        try { stagingBuffer.unmap?.(); } catch {}
      }
      if (stagingBuffer) {
        try { stagingBuffer.destroy?.(); } catch {}
      }
    }
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
    for (const abort of [...this.captureAbortListeners]) {
      try { abort(); } catch {}
    }
    this.captureAbortListeners.clear();
    this.unbindDeviceLoss();
    this.lostListeners.clear();
    this.pipeline.dispose();
    this.nativePipeline?.dispose();
    this.nativePipeline = null;
    this.nativeHeatmapPipeline?.dispose();
    this.nativeHeatmapPipeline = null;
  }
}

if (typeof globalThis !== "undefined") {
  (globalThis as any).__PactolisWebGpuSurface = WebGpuSurface;
}
