import { incrementPerformanceCounter, isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../../performanceTelemetry.js";

interface WebGpuDeviceRef {
  readonly device: any;
  isLost(): boolean;
}

export interface WebGpuRenderPass {
  readonly texture: any;
  readonly pipeline: {
    updateResolution(width: number, height: number): void;
    uploadInstances(data: Float32Array, count: number): void;
    recordPass(passEncoder: any, count: number): void;
  };
  readonly data: Float32Array;
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly clear: { r: number; g: number; b: number; a: number };
}

interface FrameState {
  readonly callbacks: Map<number, FrameRequestCallback>;
  nextCallbackId: number;
  rafId: number | null;
  encoder: any | null;
  hasCommands: boolean;
  resolveSubmission: (() => void) | null;
  submission: Promise<void> | null;
}

/**
 * Coalesces WebGPU chart RAF callbacks that target the same window/device into one
 * command encoder and queue submission. Each callback still owns and isolates its
 * chart work; a failure in one callback does not prevent the rest from running.
 */
export class WebGpuFrameCoordinator {
  private readonly states = new WeakMap<Window, FrameState>();

  constructor(private readonly handle: WebGpuDeviceRef) {}

  schedule(win: Window, callback: FrameRequestCallback): number {
    const state = this.stateFor(win);
    const id = state.nextCallbackId++;
    state.callbacks.set(id, callback);
    if (state.rafId === null) {
      state.rafId = win.requestAnimationFrame((timestamp) => this.dispatch(win, state, timestamp));
    }
    return id;
  }

  cancel(win: Window, id: number): void {
    const state = this.states.get(win);
    if (!state) return;
    state.callbacks.delete(id);
    if (state.callbacks.size === 0 && state.rafId !== null) {
      win.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  /** Returns false outside a coordinated RAF so direct surface use can keep its own submit. */
  recordPass(win: Window, frame: WebGpuRenderPass): boolean {
    const state = this.states.get(win);
    if (!state || state.submission === null || this.handle.isLost()) return false;

    if (state.encoder === null) {
      state.encoder = this.handle.device.createCommandEncoder({ label: "WebGpuSharedFrameCommandEncoder" });
    }

    const passEncoder = state.encoder.beginRenderPass({
      label: "WebGpuChartRenderPass",
      colorAttachments: [
        {
          view: frame.texture.createView ? frame.texture.createView() : frame.texture,
          clearValue: frame.clear,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    state.hasCommands = true;
    try {
      if (frame.count > 0) {
        frame.pipeline.updateResolution(frame.width, frame.height);
        frame.pipeline.uploadInstances(frame.data, frame.count);
        frame.pipeline.recordPass(passEncoder, frame.count);
      }
    } finally {
      passEncoder.end();
    }
    return true;
  }

  /** A WebGPU capture scheduled from a chart RAF must wait for that RAF's shared submit. */
  waitForCurrentSubmission(win: Window): Promise<void> {
    return this.states.get(win)?.submission ?? Promise.resolve();
  }

  private stateFor(win: Window): FrameState {
    let state = this.states.get(win);
    if (!state) {
      state = {
        callbacks: new Map(),
        nextCallbackId: 1,
        rafId: null,
        encoder: null,
        hasCommands: false,
        resolveSubmission: null,
        submission: null,
      };
      this.states.set(win, state);
    }
    return state;
  }

  private dispatch(win: Window, state: FrameState, timestamp: number): void {
    state.rafId = null;
    state.encoder = null;
    state.hasCommands = false;
    state.submission = new Promise<void>((resolve) => { state.resolveSubmission = resolve; });

    // Callbacks can schedule the next frame or cancel another chart's pending frame.
    // Keep the map live so cancellation during this dispatch remains effective.
    const callbacks = [...state.callbacks.keys()];
    for (const id of callbacks) {
      const callback = state.callbacks.get(id);
      if (!callback) continue;
      state.callbacks.delete(id);
      try {
        callback(timestamp);
      } catch (error) {
        incrementPerformanceCounter("chart.gpu.frame.callbackFailed");
        console.error("[WebGPU] chart frame failed; continuing the shared device frame", error);
      }
    }

    try {
      if (state.encoder && state.hasCommands && !this.handle.isLost()) {
        const submitStartedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
        const commandBuffer = state.encoder.finish();
        this.handle.device.queue.submit([commandBuffer]);
        incrementPerformanceCounter("gpu.backend.webgpu.frame.submits");
        if (submitStartedAt !== null) {
          recordPerformanceDuration("gpu.backend.webgpu.frame.submit.ms", performance.now() - submitStartedAt);
        }
      }
    } catch (error) {
      incrementPerformanceCounter("chart.gpu.frame.submitFailed");
      console.error("[WebGPU] shared frame submission failed", error);
    } finally {
      state.encoder = null;
      state.hasCommands = false;
      state.submission = null;
      state.resolveSubmission?.();
      state.resolveSubmission = null;
    }
  }
}
