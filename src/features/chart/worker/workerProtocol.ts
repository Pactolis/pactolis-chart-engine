/**
 * Worker-ready chart runtime protocol, bounded credit/backpressure queue,
 * and explicit main-thread vs worker host boundary manifest.
 *
 * Strictly DOM-free: must never reference browser global DOM or window objects.
 */

export type WorkerPortChannel = "ingress" | "history" | "main";

export type WorkerSurfaceRole = "gpu-scene" | "annotation" | "interaction";

export type WorkerInputEvent =
  | {
      type: "pointermove";
      x: number;
      y: number;
      buttons?: number;
      modifiers?: number;
      timestamp: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      deltaMode?: number;
      timestamp: number;
    }
  | {
      type: "pointerdown" | "pointerup";
      x: number;
      y: number;
      button: number;
      buttons?: number;
      timestamp: number;
    }
  | {
      type: "keydown";
      key: string;
      code: string;
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      timestamp: number;
    }
  | {
      type: "blur";
      timestamp: number;
    };

export interface WorkerHistoryBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WorkerSurfaceDescriptor {
  role: WorkerSurfaceRole;
  zIndex: number;
  width: number;
  height: number;
  dpr: number;
}

export interface WorkerEnvelopeBase<
  C extends WorkerPortChannel = WorkerPortChannel,
  K extends string = string,
  P = unknown,
> {
  channel: C;
  kind: K;
  panelId: string;
  marketId: string;
  generation: number;
  seq: number;
  revision: number;
  requestId?: string;
  abort?: boolean;
  credit?: number;
  ack?: number;
  transfer?: Transferable[];
  payload: P;
}

export type IngressWorkerMessage =
  | WorkerEnvelopeBase<
      "ingress",
      "ingress:tick",
      {
        price: number;
        size: number;
        timestamp: number;
        side?: "buy" | "sell";
        tradeId?: string;
      }
    >
  | WorkerEnvelopeBase<
      "ingress",
      "ingress:bar",
      WorkerHistoryBar & {
        timeframe?: string;
        closed?: boolean;
      }
    >
  | WorkerEnvelopeBase<
      "ingress",
      "ingress:book",
      {
        bids?: ArrayBuffer;
        asks?: ArrayBuffer;
        timestamp: number;
      }
    >
  | WorkerEnvelopeBase<"ingress", "ingress:credit", { granted: number }>
  | WorkerEnvelopeBase<"ingress", "ingress:ack", { ackedSeq: number }>;

export type HistoryWorkerMessage =
  | WorkerEnvelopeBase<
      "history",
      "history:request",
      {
        timeframe: string;
        from: number;
        to: number;
        limit?: number;
      }
    >
  | WorkerEnvelopeBase<
      "history",
      "history:chunk",
      {
        timeframe: string;
        bars: ReadonlyArray<WorkerHistoryBar> | ArrayBuffer;
        hasMore: boolean;
        chunkIndex: number;
      }
    >
  | WorkerEnvelopeBase<
      "history",
      "history:complete",
      {
        timeframe: string;
        totalBars: number;
      }
    >
  | WorkerEnvelopeBase<
      "history",
      "history:error",
      {
        code: string;
        message: string;
        recoverable: boolean;
      }
    >
  | WorkerEnvelopeBase<"history", "history:credit", { granted: number }>
  | WorkerEnvelopeBase<"history", "history:ack", { ackedSeq: number }>;

export type MainWorkerMessage =
  | WorkerEnvelopeBase<
      "main",
      "main:init",
      {
        surfaces: ReadonlyArray<WorkerSurfaceDescriptor>;
        viewport: { width: number; height: number; dpr: number };
        backendPreference?: "auto" | "webgpu" | "webgl2" | "canvas2d";
        offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
      }
    >
  | WorkerEnvelopeBase<
      "main",
      "main:attach-ports",
      {
        hasIngressPort: boolean;
        hasHistoryPort: boolean;
      }
    >
  | WorkerEnvelopeBase<
      "main",
      "main:resize",
      {
        width: number;
        height: number;
        dpr: number;
      }
    >
  | WorkerEnvelopeBase<"main", "main:input", WorkerInputEvent>
  | WorkerEnvelopeBase<
      "main",
      "main:capture-request",
      {
        format: "png" | "bitmap";
        includeOverlays?: boolean;
      }
    >
  | WorkerEnvelopeBase<
      "main",
      "main:capture-response",
      {
        ok: boolean;
        width?: number;
        height?: number;
        buffer?: ArrayBuffer;
        error?: string;
      }
    >
  | WorkerEnvelopeBase<"main", "main:hit-test-request", { x: number; y: number }>
  | WorkerEnvelopeBase<
      "main",
      "main:hit-test-response",
      {
        hit: boolean;
        targetKind?: string;
        targetId?: string;
        price?: number;
        time?: number;
      }
    >
  | WorkerEnvelopeBase<"main", "main:tooltip-request", { x: number; y: number }>
  | WorkerEnvelopeBase<
      "main",
      "main:tooltip-response",
      {
        visible: boolean;
        title?: string;
        lines?: ReadonlyArray<string>;
        x: number;
        y: number;
      }
    >
  | WorkerEnvelopeBase<
      "main",
      "main:recycle-buffer",
      {
        bufferId?: string;
        buffer: ArrayBuffer;
      }
    >
  | WorkerEnvelopeBase<
      "main",
      "main:lifecycle",
      {
        action: "pause" | "resume" | "rehome" | "dispose" | "epoch-bump" | "abort";
        reason?: string;
        surfaces?: ReadonlyArray<WorkerSurfaceDescriptor>;
        offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
      }
    >
  | WorkerEnvelopeBase<"main", "main:credit", { granted: number }>
  | WorkerEnvelopeBase<"main", "main:ack", { ackedSeq: number }>
  | WorkerEnvelopeBase<
      "main",
      "main:error",
      {
        code: string;
        message: string;
        fatal: boolean;
      }
    >;

export type WorkerProtocolMessage =
  | IngressWorkerMessage
  | HistoryWorkerMessage
  | MainWorkerMessage;

export interface WorkerRuntimeHostBoundary {
  readonly mainThreadResponsibilities: readonly string[];
  readonly workerCoreResponsibilities: readonly string[];
  readonly forbiddenInWorker: readonly string[];
  readonly zeroRelayRule: string;
}

export const WORKER_RUNTIME_HOST_BOUNDARY: WorkerRuntimeHostBoundary = {
  mainThreadResponsibilities: [
    "DOM canvas mounting and Z-order container layout",
    "Focus management and keyboard/pointer event capture",
    "Accessibility announcements and ARIA attributes",
    "ResizeObserver tracking and DPR changes",
    "Worker bootstrap, MessageChannel creation, and direct port wiring",
    "Popout window re-homing and canvas node recreation on recovery",
  ],
  workerCoreResponsibilities: [
    "Chart panel state, viewport, and series/bar aggregation",
    "Frame scheduling and dirty-pass orchestration",
    "Technical analysis, volume profile, and footprint computation",
    "WebGPU / WebGL2 / 2D OffscreenCanvas rendering",
    "Deterministic hit-testing, tooltip evaluation, and capture export",
    "Direct ingress tick and history chunk consumption",
  ],
  forbiddenInWorker: [
    "DOM node access or style mutation",
    "Focus or ARIA tree manipulation",
    "ResizeObserver instantiation",
    "Main-thread tick or history relay",
  ],
  zeroRelayRule:
    "Main thread only wires MessagePorts; ingress <-> chart and history <-> chart communicate directly without main-thread tick or history relay.",
};

export interface BoundedQueueOptions {
  maxSize?: number;
  initialCredits?: number;
  initialGeneration?: number;
}

export interface BoundedQueueStats {
  queued: number;
  enqueued: number;
  dequeued: number;
  droppedStale: number;
  droppedOverflow: number;
  coalesced: number;
  availableCredits: number;
  generation: number;
}

function isOrderedBarrierMessage(msg: WorkerProtocolMessage): boolean {
  if (msg.kind === "main:resize" || msg.kind === "main:capture-request" || msg.kind === "main:lifecycle") {
    return true;
  }
  if (msg.kind === "main:input") {
    const t = msg.payload.type;
    return t === "pointerdown" || t === "pointerup" || t === "keydown" || t === "blur";
  }
  return false;
}

function isCoalescibleInputKind(msg: WorkerProtocolMessage): msg is WorkerEnvelopeBase<"main", "main:input", WorkerInputEvent> {
  return (
    msg.kind === "main:input" &&
    (msg.payload.type === "pointermove" || msg.payload.type === "wheel")
  );
}

/**
 * Bounded credit/backpressure queue for worker MessagePort envelopes.
 *
 * - Drops messages from stale generations (`generation < currentGeneration`)
 * - Coalesces consecutive high-frequency `pointermove` and `wheel` events
 *   without ever reordering across ordered barriers (`pointerdown`, `pointerup`,
 *   `keydown`, `blur`, `main:capture-request`, `main:resize`, `main:lifecycle`).
 * - Enforces bounded capacity and credit-based flow control.
 */
export class BoundedWorkerPortQueue<T extends WorkerProtocolMessage = WorkerProtocolMessage> {
  private readonly items: T[] = [];
  private readonly maxSize: number;
  private availableCredits: number;
  private currentGeneration: number;
  private enqueuedCount = 0;
  private dequeuedCount = 0;
  private droppedStaleCount = 0;
  private droppedOverflowCount = 0;
  private coalescedCount = 0;

  constructor(options: BoundedQueueOptions = {}) {
    this.maxSize = Math.max(1, options.maxSize ?? 256);
    this.availableCredits = Math.max(0, options.initialCredits ?? 64);
    this.currentGeneration = Math.max(0, options.initialGeneration ?? 0);
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get size(): number {
    return this.items.length;
  }

  get credits(): number {
    return this.availableCredits;
  }

  bumpGeneration(nextGeneration: number): number {
    if (nextGeneration <= this.currentGeneration) {
      return 0;
    }
    this.currentGeneration = nextGeneration;
    let purged = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].generation < this.currentGeneration) {
        this.items.splice(i, 1);
        purged++;
        this.droppedStaleCount++;
      }
    }
    return purged;
  }

  grantCredits(amount: number): void {
    if (amount > 0 && Number.isFinite(amount)) {
      this.availableCredits += Math.floor(amount);
    }
  }

  enqueue(msg: T): "enqueued" | "coalesced" | "dropped-stale" | "dropped-overflow" {
    if (msg.generation < this.currentGeneration) {
      this.droppedStaleCount++;
      return "dropped-stale";
    }

    if (isCoalescibleInputKind(msg)) {
      const coalesced = this.tryCoalesceTrailingInput(msg);
      if (coalesced) {
        this.coalescedCount++;
        return "coalesced";
      }
    }

    if (this.items.length >= this.maxSize) {
      const evicted = this.evictLowestPriorityItem();
      if (!evicted) {
        this.droppedOverflowCount++;
        return "dropped-overflow";
      }
      this.droppedOverflowCount++;
    }

    this.items.push(msg);
    this.enqueuedCount++;
    return "enqueued";
  }

  /**
   * Dequeue up to `limit` items while respecting available credits.
   * Passing `ignoreCredits = true` allows local consumer draining.
   */
  drain(limit = this.items.length, ignoreCredits = false): T[] {
    const out: T[] = [];
    const maxItems = Math.max(0, Math.min(limit, this.items.length));
    while (out.length < maxItems && this.items.length > 0) {
      if (!ignoreCredits && this.availableCredits <= 0) {
        break;
      }
      const next = this.items.shift();
      if (!next) break;
      if (next.generation < this.currentGeneration) {
        this.droppedStaleCount++;
        continue;
      }
      if (!ignoreCredits) {
        this.availableCredits--;
      }
      this.dequeuedCount++;
      out.push(next);
    }
    return out;
  }

  dequeue(ignoreCredits = false): T | undefined {
    const batch = this.drain(1, ignoreCredits);
    return batch[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  getStats(): BoundedQueueStats {
    return {
      queued: this.items.length,
      enqueued: this.enqueuedCount,
      dequeued: this.dequeuedCount,
      droppedStale: this.droppedStaleCount,
      droppedOverflow: this.droppedOverflowCount,
      coalesced: this.coalescedCount,
      availableCredits: this.availableCredits,
      generation: this.currentGeneration,
    };
  }

  private tryCoalesceTrailingInput(
    incoming: WorkerEnvelopeBase<"main", "main:input", WorkerInputEvent>,
  ): boolean {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const candidate = this.items[i];
      if (isOrderedBarrierMessage(candidate)) {
        // Never coalesce across ordered input/lifecycle/resize/capture barriers.
        return false;
      }
      if (
        isCoalescibleInputKind(candidate) &&
        candidate.panelId === incoming.panelId &&
        candidate.generation === incoming.generation &&
        candidate.payload.type === incoming.payload.type
      ) {
        if (incoming.payload.type === "wheel" && candidate.payload.type === "wheel") {
          const mergedWheel: WorkerInputEvent = {
            ...incoming.payload,
            deltaX: candidate.payload.deltaX + incoming.payload.deltaX,
            deltaY: candidate.payload.deltaY + incoming.payload.deltaY,
          };
          this.items[i] = {
            ...incoming,
            payload: mergedWheel,
          } as T;
        } else {
          this.items[i] = incoming as unknown as T;
        }
        return true;
      }
    }
    return false;
  }

  private evictLowestPriorityItem(): boolean {
    // Prefer dropping coalescible pointermove/wheel or high-volume ingress ticks first.
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (isCoalescibleInputKind(item) || item.kind === "ingress:tick") {
        this.items.splice(i, 1);
        return true;
      }
    }
    // Never drop ordered barrier messages if avoidable; fallback to oldest non-barrier.
    for (let i = 0; i < this.items.length; i++) {
      if (!isOrderedBarrierMessage(this.items[i])) {
        this.items.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}
