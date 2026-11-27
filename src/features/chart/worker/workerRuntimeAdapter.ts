/**
 * Strictly DOM-free worker coordinator (`WorkerChartEndpoint`) and main-thread
 * host bridge (`WorkerChartHostBridge`) communicating over direct MessagePorts.
 *
 * Main thread ONLY wires MessagePorts and handles control/UI envelopes;
 * ingress ticks and history chunks flow directly worker <-> worker with zero
 * main-thread relay.
 */

import {
  BoundedWorkerPortQueue,
  type HistoryWorkerMessage,
  type IngressWorkerMessage,
  type MainWorkerMessage,
  type WorkerChartStatePatch,
  type WorkerEnvelopeBase,
  type WorkerInputEvent,
  type WorkerPortChannel,
  type WorkerProtocolMessage,
  type WorkerSurfaceDescriptor,
  type WorkerSurfaceRole,
} from "./workerProtocol.js";

function collectOffscreenTransfers(
  offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>,
): Transferable[] {
  if (!offscreenCanvases) return [];
  const transfers: Transferable[] = [];
  for (const canvas of Object.values(offscreenCanvases)) {
    if (canvas && !transfers.includes(canvas as unknown as Transferable)) {
      transfers.push(canvas as unknown as Transferable);
    }
  }
  return transfers;
}

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start?: () => void;
  close?: () => void;
}

export interface HostBridgePorts {
  mainPort: MessagePortLike;
  ingressPort?: MessagePortLike;
  historyPort?: MessagePortLike;
  /**
   * When true, `ingressPort` and `historyPort` are transferred directly to the
   * worker over `mainPort` via `main:attach-ports`. When false/omitted, caller
   * wired the MessageChannel pair directly to the worker already.
   */
  transferDirectPorts?: boolean;
}

export interface HostBridgeOptions {
  panelId: string;
  marketId: string;
  maxQueueSize?: number;
  initialCredits?: number;
  maxRestarts?: number;
  closePortsOnDispose?: boolean;
  onStatusChange?: (status: HostBridgeStatus, detail?: string) => void;
  onError?: (error: { code: string; message: string; fatal: boolean }) => void;
  onDiagnostic?: (
    payload: Extract<MainWorkerMessage, { kind: "main:diagnostic" }>["payload"],
    envelope: MainWorkerMessage,
  ) => void;
  onRecycleBuffer?: (payload: { bufferId?: string; buffer: ArrayBuffer }) => void;
}

export type HostBridgeStatus = "idle" | "connected" | "recovering" | "failed" | "disposed";

interface PendingRequestEntry {
  kind: "capture" | "hit-test" | "tooltip";
  generation: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface HostBridgeStats {
  status: HostBridgeStatus;
  generation: number;
  revision: number;
  restartCount: number;
  pendingRequests: number;
  queue: ReturnType<BoundedWorkerPortQueue["getStats"]>;
}

/**
 * Main-thread bridge that wires `main <-> chart`, `ingress <-> chart`, and
 * `history <-> chart` MessagePorts without ever relaying ingress or history data.
 */
export class WorkerChartHostBridge {
  private readonly panelId: string;
  private readonly marketId: string;
  private readonly maxRestarts: number;
  private readonly closePortsOnDispose: boolean;
  private readonly outboundQueue: BoundedWorkerPortQueue<MainWorkerMessage>;
  private readonly pendingRequests = new Map<string, PendingRequestEntry>();
  private readonly onStatusChange?: HostBridgeOptions["onStatusChange"];
  private readonly onError?: HostBridgeOptions["onError"];
  private readonly onDiagnostic?: HostBridgeOptions["onDiagnostic"];
  private readonly onRecycleBuffer?: HostBridgeOptions["onRecycleBuffer"];

  private mainPort: MessagePortLike | null = null;
  private ingressPort: MessagePortLike | null = null;
  private historyPort: MessagePortLike | null = null;
  private status: HostBridgeStatus = "idle";
  private generation = 0;
  private revision = 0;
  private seq = 0;
  private requestCounter = 0;
  private restartCount = 0;
  private disposed = false;

  private readonly handleMainMessage = (event: { data: unknown }): void => {
    const msg = event.data as MainWorkerMessage | undefined;
    if (!msg || typeof msg !== "object" || msg.channel !== "main") {
      return;
    }

    if (typeof msg.credit === "number" && msg.credit > 0) {
      this.outboundQueue.grantCredits(msg.credit);
      this.flushOutbound();
    }

    if (msg.kind === "main:credit") {
      this.outboundQueue.grantCredits(msg.payload.granted);
      this.flushOutbound();
      return;
    }

    if (msg.kind === "main:ack") {
      this.outboundQueue.grantCredits(1);
      this.flushOutbound();
      return;
    }

    if (msg.kind === "main:recycle-buffer") {
      this.onRecycleBuffer?.(msg.payload);
      return;
    }

    if (msg.kind === "main:error") {
      this.onError?.(msg.payload);
      return;
    }

    if (msg.kind === "main:diagnostic") {
      this.onDiagnostic?.(msg.payload, msg);
      return;
    }

    if (msg.generation < this.generation) {
      return;
    }

    if (
      msg.kind === "main:capture-response" ||
      msg.kind === "main:hit-test-response" ||
      msg.kind === "main:tooltip-response"
    ) {
      const reqId = msg.requestId;
      if (!reqId) return;
      const pending = this.pendingRequests.get(reqId);
      if (!pending) return;
      this.pendingRequests.delete(reqId);
      if (msg.abort || pending.generation < this.generation) {
        pending.reject(new Error(`Request ${reqId} aborted due to generation mismatch or abort flag`));
        return;
      }
      pending.resolve(msg.payload);
    }
  };

  constructor(options: HostBridgeOptions) {
    this.panelId = options.panelId;
    this.marketId = options.marketId;
    this.maxRestarts = Math.max(0, options.maxRestarts ?? 3);
    this.closePortsOnDispose = options.closePortsOnDispose ?? false;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
    this.onDiagnostic = options.onDiagnostic;
    this.onRecycleBuffer = options.onRecycleBuffer;
    this.outboundQueue = new BoundedWorkerPortQueue<MainWorkerMessage>({
      maxSize: options.maxQueueSize ?? 256,
      initialCredits: options.initialCredits ?? 64,
      initialGeneration: 0,
    });
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentStatus(): HostBridgeStatus {
    return this.status;
  }

  attachPorts(ports: HostBridgePorts): void {
    this.assertNotDisposed();
    this.detachMainPort();

    this.mainPort = ports.mainPort;
    this.ingressPort = ports.ingressPort ?? null;
    this.historyPort = ports.historyPort ?? null;

    this.mainPort.addEventListener("message", this.handleMainMessage);
    this.mainPort.start?.();

    if (ports.transferDirectPorts && (this.ingressPort || this.historyPort)) {
      const transfer: Transferable[] = [];
      if (this.ingressPort) transfer.push(this.ingressPort as unknown as Transferable);
      if (this.historyPort) transfer.push(this.historyPort as unknown as Transferable);
      this.sendDirect({
        channel: "main",
        kind: "main:attach-ports",
        panelId: this.panelId,
        marketId: this.marketId,
        generation: this.generation,
        seq: ++this.seq,
        revision: this.revision,
        transfer,
        payload: {
          hasIngressPort: Boolean(this.ingressPort),
          hasHistoryPort: Boolean(this.historyPort),
        },
      });
    }

    this.setStatus("connected");
    this.flushOutbound();
  }

  sendInit(
    surfaces: ReadonlyArray<WorkerSurfaceDescriptor>,
    viewport: { width: number; height: number; dpr: number },
    options?: {
      backendPreference?: "auto" | "webgpu" | "webgl2" | "canvas2d";
      offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
    },
  ): void {
    const transfer = collectOffscreenTransfers(options?.offscreenCanvases);
    this.enqueueAndFlush({
      channel: "main",
      kind: "main:init",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: ++this.revision,
      ...(transfer.length > 0 ? { transfer } : {}),
      payload: {
        surfaces,
        viewport,
        ...(options?.backendPreference !== undefined ? { backendPreference: options.backendPreference } : {}),
        ...(options?.offscreenCanvases !== undefined ? { offscreenCanvases: options.offscreenCanvases } : {}),
      },
    });
  }

  sendInput(event: WorkerInputEvent): void {
    this.enqueueAndFlush({
      channel: "main",
      kind: "main:input",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: this.revision,
      payload: event,
    });
  }

  sendResize(width: number, height: number, dpr: number): void {
    this.enqueueAndFlush({
      channel: "main",
      kind: "main:resize",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: ++this.revision,
      payload: { width, height, dpr },
    });
  }

  sendStateUpdate(patch: WorkerChartStatePatch): void {
    this.enqueueAndFlush({
      channel: "main",
      kind: "main:state-update",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: ++this.revision,
      payload: patch,
    });
  }

  sendLifecycle(
    action: "pause" | "resume" | "rehome" | "dispose" | "epoch-bump" | "abort",
    reason?: string,
    options?: {
      surfaces?: ReadonlyArray<WorkerSurfaceDescriptor>;
      offscreenCanvases?: Partial<Record<WorkerSurfaceRole, OffscreenCanvas>>;
    },
  ): void {
    const transfer = collectOffscreenTransfers(options?.offscreenCanvases);
    this.enqueueAndFlush({
      channel: "main",
      kind: "main:lifecycle",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: ++this.revision,
      ...(transfer.length > 0 ? { transfer } : {}),
      payload: {
        action,
        ...(reason ? { reason } : {}),
        ...(options?.surfaces ? { surfaces: options.surfaces } : {}),
        ...(options?.offscreenCanvases ? { offscreenCanvases: options.offscreenCanvases } : {}),
      },
    });
  }

  bumpGeneration(reason?: string): number {
    this.assertNotDisposed();
    this.generation++;
    this.revision++;
    this.outboundQueue.bumpGeneration(this.generation);
    this.rejectPendingBelowGeneration(this.generation, reason ?? "Generation bumped");
    this.sendLifecycle("epoch-bump", reason);
    return this.generation;
  }

  abortPending(reason = "Aborted by host"): void {
    this.assertNotDisposed();
    this.rejectAllPending(reason);
    this.sendDirect({
      channel: "main",
      kind: "main:lifecycle",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: this.revision,
      abort: true,
      payload: { action: "abort", reason },
    });
  }

  requestCapture(options: { format: "png" | "bitmap"; includeOverlays?: boolean }): Promise<{
    ok: boolean;
    width?: number;
    height?: number;
    buffer?: ArrayBuffer;
    error?: string;
  }> {
    return this.sendCorrelatedRequest("capture", "main:capture-request", options);
  }

  requestHitTest(x: number, y: number): Promise<{
    hit: boolean;
    targetKind?: string;
    targetId?: string;
    price?: number;
    time?: number;
  }> {
    return this.sendCorrelatedRequest("hit-test", "main:hit-test-request", { x, y });
  }

  requestTooltip(x: number, y: number): Promise<{
    visible: boolean;
    title?: string;
    lines?: ReadonlyArray<string>;
    x: number;
    y: number;
  }> {
    return this.sendCorrelatedRequest("tooltip", "main:tooltip-request", { x, y });
  }

  /**
   * Bounded recovery on worker crash. Increments generation, clears stale
   * pending requests, detaches old listeners, and optionally re-attaches new ports.
   */
  handleWorkerCrash(reason: string, newPorts?: HostBridgePorts): boolean {
    if (this.disposed) return false;
    this.detachMainPort(true);
    this.rejectAllPending(`Worker crashed: ${reason}`);

    if (this.restartCount >= this.maxRestarts) {
      this.setStatus("failed", `Max worker restarts (${this.maxRestarts}) exceeded: ${reason}`);
      return false;
    }

    this.restartCount++;
    this.generation++;
    this.revision++;
    this.seq = 0;
    this.outboundQueue.bumpGeneration(this.generation);
    this.setStatus("recovering", reason);

    if (newPorts) {
      this.attachPorts(newPorts);
    }
    return true;
  }

  flushOutbound(): number {
    if (!this.mainPort || this.disposed) return 0;
    const ready = this.outboundQueue.drain(this.outboundQueue.size, false);
    for (const msg of ready) {
      this.sendDirect(msg);
    }
    return ready.length;
  }

  getStats(): HostBridgeStats {
    return {
      status: this.status,
      generation: this.generation,
      revision: this.revision,
      restartCount: this.restartCount,
      pendingRequests: this.pendingRequests.size,
      queue: this.outboundQueue.getStats(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending("Host bridge disposed");
    this.outboundQueue.clear();
    this.detachMainPort(true);
    if (this.closePortsOnDispose) {
      this.ingressPort?.close?.();
      this.historyPort?.close?.();
    }
    this.ingressPort = null;
    this.historyPort = null;
    this.setStatus("disposed");
  }

  private sendCorrelatedRequest<R>(
    kind: PendingRequestEntry["kind"],
    messageKind: "main:capture-request" | "main:hit-test-request" | "main:tooltip-request",
    payload: unknown,
  ): Promise<R> {
    this.assertNotDisposed();
    const requestId = `req-${this.generation}-${++this.requestCounter}`;
    const generation = this.generation;
    return new Promise<R>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        kind,
        generation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.enqueueAndFlush({
        channel: "main",
        kind: messageKind,
        panelId: this.panelId,
        marketId: this.marketId,
        generation,
        seq: ++this.seq,
        revision: this.revision,
        requestId,
        payload,
      } as MainWorkerMessage);
    });
  }

  private enqueueAndFlush(msg: MainWorkerMessage): void {
    this.assertNotDisposed();
    this.outboundQueue.enqueue(msg);
    this.flushOutbound();
  }

  private sendDirect(msg: MainWorkerMessage): void {
    if (!this.mainPort) return;
    const transfer = msg.transfer;
    if (transfer && transfer.length > 0) {
      const wireMsg = { ...msg };
      delete wireMsg.transfer;
      this.mainPort.postMessage(wireMsg, transfer);
    } else {
      this.mainPort.postMessage(msg);
    }
  }

  private detachMainPort(closeIfConfigured = false): void {
    if (this.mainPort) {
      this.mainPort.removeEventListener("message", this.handleMainMessage);
      if (closeIfConfigured && this.closePortsOnDispose) {
        this.mainPort.close?.();
      }
      this.mainPort = null;
    }
  }

  private rejectPendingBelowGeneration(minGeneration: number, reason: string): void {
    for (const [reqId, entry] of this.pendingRequests.entries()) {
      if (entry.generation < minGeneration) {
        this.pendingRequests.delete(reqId);
        entry.reject(new Error(`${reason} (${reqId})`));
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [reqId, entry] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(reqId);
      entry.reject(new Error(`${reason} (${reqId})`));
    }
  }

  private setStatus(next: HostBridgeStatus, detail?: string): void {
    this.status = next;
    this.onStatusChange?.(next, detail);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WorkerChartHostBridge has been disposed.");
    }
  }
}

export interface WorkerEndpointHandlers {
  onInit?: (
    payload: Extract<MainWorkerMessage, { kind: "main:init" }>["payload"],
    envelope: MainWorkerMessage,
  ) => void;
  onResize?: (
    payload: Extract<MainWorkerMessage, { kind: "main:resize" }>["payload"],
    envelope: MainWorkerMessage,
  ) => void;
  onInput?: (event: WorkerInputEvent, envelope: MainWorkerMessage) => void;
  onStateUpdate?: (
    payload: Extract<MainWorkerMessage, { kind: "main:state-update" }>["payload"],
    envelope: MainWorkerMessage,
  ) => void;
  onTick?: (
    payload: Extract<IngressWorkerMessage, { kind: "ingress:tick" }>["payload"],
    envelope: IngressWorkerMessage,
  ) => void;
  onTicks?: (
    payload: Extract<IngressWorkerMessage, { kind: "ingress:ticks" }>["payload"],
    envelope: IngressWorkerMessage,
  ) => void;
  onBar?: (
    payload: Extract<IngressWorkerMessage, { kind: "ingress:bar" }>["payload"],
    envelope: IngressWorkerMessage,
  ) => void;
  onHeatmapTail?: (
    payload: Extract<IngressWorkerMessage, { kind: "ingress:heatmap-tail" }>["payload"],
    envelope: IngressWorkerMessage,
  ) => void;
  onHistoryChunk?: (
    payload: Extract<HistoryWorkerMessage, { kind: "history:chunk" }>["payload"],
    envelope: HistoryWorkerMessage,
  ) => void;
  onHeatmapChunk?: (
    payload: Extract<HistoryWorkerMessage, { kind: "history:heatmap-chunk" }>["payload"],
    envelope: HistoryWorkerMessage,
  ) => void;
  onCapture?: (
    payload: Extract<MainWorkerMessage, { kind: "main:capture-request" }>["payload"],
    envelope: MainWorkerMessage,
  ) =>
    | Extract<MainWorkerMessage, { kind: "main:capture-response" }>["payload"]
    | Promise<Extract<MainWorkerMessage, { kind: "main:capture-response" }>["payload"]>;
  onHitTest?: (
    payload: Extract<MainWorkerMessage, { kind: "main:hit-test-request" }>["payload"],
    envelope: MainWorkerMessage,
  ) => Extract<MainWorkerMessage, { kind: "main:hit-test-response" }>["payload"];
  onTooltip?: (
    payload: Extract<MainWorkerMessage, { kind: "main:tooltip-request" }>["payload"],
    envelope: MainWorkerMessage,
  ) => Extract<MainWorkerMessage, { kind: "main:tooltip-response" }>["payload"];
  onLifecycle?: (
    payload: Extract<MainWorkerMessage, { kind: "main:lifecycle" }>["payload"],
    envelope: MainWorkerMessage,
  ) => void;
}

export interface WorkerEndpointOptions {
  panelId: string;
  marketId: string;
  initialGeneration?: number;
  maxSeenTradeIds?: number;
  handlers?: WorkerEndpointHandlers;
}

export interface WorkerEndpointStats {
  generation: number;
  processedIngress: number;
  processedHistory: number;
  processedMain: number;
  droppedStale: number;
  droppedAborted: number;
  droppedOutOfOrder: number;
  droppedDuplicate: number;
  coalescedInputs: number;
}

/**
 * Worker-side receiver enforcing generation/epoch filtering, sequence monotonicity,
 * duplicate bar/trade prevention, input coalescing, request/response correlation,
 * and transferable buffer recycling.
 */
export class WorkerChartEndpoint {
  private readonly panelId: string;
  private readonly marketId: string;
  private readonly maxSeenTradeIds: number;
  private readonly maxTrackedBarRevisions: number;
  private readonly handlers: WorkerEndpointHandlers;
  private readonly inputQueue: BoundedWorkerPortQueue<MainWorkerMessage>;
  private readonly lastSeqByChannel = new Map<WorkerPortChannel, number>();
  private readonly seenTradeIds = new Set<string>();
  private readonly lastBarRevisionByKey = new Map<string, number>();

  private mainPort: MessagePortLike | null = null;
  private ingressPort: MessagePortLike | null = null;
  private historyPort: MessagePortLike | null = null;

  private generation: number;
  private seq = 0;
  private revision = 0;
  private processedIngress = 0;
  private processedHistory = 0;
  private processedMain = 0;
  private droppedStale = 0;
  private droppedAborted = 0;
  private droppedOutOfOrder = 0;
  private droppedDuplicate = 0;
  private disposed = false;

  private readonly onMainMessage = (event: { data: unknown }): void => {
    this.handleEnvelope(event.data as WorkerProtocolMessage);
  };

  private readonly onIngressMessage = (event: { data: unknown }): void => {
    this.handleEnvelope(event.data as WorkerProtocolMessage);
  };

  private readonly onHistoryMessage = (event: { data: unknown }): void => {
    this.handleEnvelope(event.data as WorkerProtocolMessage);
  };

  constructor(options: WorkerEndpointOptions) {
    this.panelId = options.panelId;
    this.marketId = options.marketId;
    this.maxSeenTradeIds = Math.max(64, options.maxSeenTradeIds ?? 2048);
    this.maxTrackedBarRevisions = Math.max(256, this.maxSeenTradeIds * 4);
    this.handlers = options.handlers ?? {};
    this.generation = Math.max(0, options.initialGeneration ?? 0);
    this.inputQueue = new BoundedWorkerPortQueue<MainWorkerMessage>({
      maxSize: 256,
      initialCredits: 256,
      initialGeneration: this.generation,
    });
  }

  attachPorts(ports: {
    mainPort: MessagePortLike;
    ingressPort?: MessagePortLike;
    historyPort?: MessagePortLike;
  }): void {
    this.assertNotDisposed();
    this.detachPorts();

    this.mainPort = ports.mainPort;
    this.ingressPort = ports.ingressPort ?? null;
    this.historyPort = ports.historyPort ?? null;

    this.mainPort.addEventListener("message", this.onMainMessage);
    this.mainPort.start?.();

    if (this.ingressPort) {
      this.ingressPort.addEventListener("message", this.onIngressMessage);
      this.ingressPort.start?.();
    }
    if (this.historyPort) {
      this.historyPort.addEventListener("message", this.onHistoryMessage);
      this.historyPort.start?.();
    }
  }

  handleEnvelope(msg: WorkerProtocolMessage | undefined): void {
    if (this.disposed || !msg || typeof msg !== "object") {
      return;
    }

    if (msg.kind === "main:lifecycle" && msg.payload.action === "epoch-bump") {
      if (msg.generation >= this.generation) {
        this.generation = msg.generation;
        this.inputQueue.bumpGeneration(this.generation);
        this.lastSeqByChannel.clear();
        this.lastBarRevisionByKey.clear();
        this.handlers.onLifecycle?.(msg.payload, msg);
      } else {
        this.droppedStale++;
      }
      return;
    }

    if (msg.generation < this.generation) {
      this.droppedStale++;
      return;
    }

    if (msg.abort === true) {
      this.droppedAborted++;
      return;
    }

    const lastSeq = this.lastSeqByChannel.get(msg.channel);
    if (lastSeq !== undefined && msg.seq <= lastSeq) {
      this.droppedOutOfOrder++;
      return;
    }
    this.lastSeqByChannel.set(msg.channel, msg.seq);

    if (msg.channel === "ingress") {
      this.handleIngressMessage(msg);
      return;
    }
    if (msg.channel === "history") {
      this.handleHistoryMessage(msg);
      return;
    }
    this.handleMainControlMessage(msg);
  }

  /**
   * Flushes coalesced input events (`pointermove`, `wheel`) while preserving
   * strict ordering across `pointerdown`, `pointerup`, `keydown`, and `blur`.
   */
  flushInputs(): number {
    const batch = this.inputQueue.drain(this.inputQueue.size, true);
    for (const msg of batch) {
      if (msg.kind === "main:input") {
        this.handlers.onInput?.(msg.payload, msg);
      }
    }
    return batch.length;
  }

  grantHostCredits(amount: number): void {
    if (!this.mainPort || this.disposed) return;
    this.mainPort.postMessage({
      channel: "main",
      kind: "main:credit",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: this.revision,
      credit: amount,
      payload: { granted: amount },
    } satisfies MainWorkerMessage);
  }

  sendHistoryAck(ackedSeq: number, generation = this.generation): void {
    if (!this.historyPort || this.disposed || generation < this.generation) return;
    this.historyPort.postMessage({
      channel: "history",
      kind: "history:ack",
      panelId: this.panelId,
      marketId: this.marketId,
      generation,
      seq: ++this.seq,
      revision: this.revision,
      payload: { ackedSeq },
    } satisfies HistoryWorkerMessage);
  }

  /**
   * Emits `ingress:credit` on `ingressPort` after a batch is applied.
   * Choice: `ingress:credit` (`{ granted: count }`) rather than `ingress:ack`
   * so the ingress producer can enforce a tick-count in-flight budget.
   */
  grantIngressCredits(granted: number): void {
    if (!this.ingressPort || this.disposed || granted <= 0 || !Number.isFinite(granted)) return;
    const safeGranted = Math.floor(granted);
    this.ingressPort.postMessage({
      channel: "ingress",
      kind: "ingress:credit",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: this.revision,
      credit: safeGranted,
      payload: { granted: safeGranted },
    } satisfies IngressWorkerMessage);
  }

  emitDiagnostic(
    payload: Extract<MainWorkerMessage, { kind: "main:diagnostic" }>["payload"],
  ): void {
    if (!this.mainPort || this.disposed) return;
    this.mainPort.postMessage({
      channel: "main",
      kind: "main:diagnostic",
      panelId: this.panelId,
      marketId: this.marketId,
      generation: this.generation,
      seq: ++this.seq,
      revision: this.revision,
      payload,
    } satisfies MainWorkerMessage);
  }

  recycleBuffer(buffer: ArrayBuffer, bufferId?: string): void {
    if (!this.mainPort || this.disposed) return;
    this.mainPort.postMessage(
      {
        channel: "main",
        kind: "main:recycle-buffer",
        panelId: this.panelId,
        marketId: this.marketId,
        generation: this.generation,
        seq: ++this.seq,
        revision: this.revision,
        payload: { ...(bufferId ? { bufferId } : {}), buffer },
      } satisfies MainWorkerMessage,
      [buffer],
    );
  }

  getStats(): WorkerEndpointStats {
    return {
      generation: this.generation,
      processedIngress: this.processedIngress,
      processedHistory: this.processedHistory,
      processedMain: this.processedMain,
      droppedStale: this.droppedStale,
      droppedAborted: this.droppedAborted,
      droppedOutOfOrder: this.droppedOutOfOrder,
      droppedDuplicate: this.droppedDuplicate,
      coalescedInputs: this.inputQueue.getStats().coalesced,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachPorts();
    this.inputQueue.clear();
    this.lastSeqByChannel.clear();
    this.seenTradeIds.clear();
    this.lastBarRevisionByKey.clear();
    this.mainPort = null;
    this.ingressPort = null;
    this.historyPort = null;
  }

  private handleIngressMessage(msg: IngressWorkerMessage): void {
    if (msg.kind === "ingress:tick") {
      const tradeId = msg.payload.tradeId;
      if (tradeId) {
        if (this.seenTradeIds.has(tradeId)) {
          this.droppedDuplicate++;
          return;
        }
        if (this.seenTradeIds.size >= this.maxSeenTradeIds) {
          const oldest = this.seenTradeIds.values().next().value;
          if (oldest !== undefined) {
            this.seenTradeIds.delete(oldest);
          }
        }
        this.seenTradeIds.add(tradeId);
      }
      this.processedIngress++;
      this.handlers.onTick?.(msg.payload, msg);
      return;
    }

    if (msg.kind === "ingress:ticks") {
      this.processedIngress++;
      this.handlers.onTicks?.(msg.payload, msg);
      return;
    }

    if (msg.kind === "ingress:bar") {
      const barKey = `${msg.marketId}:${msg.payload.timeframe ?? "default"}:${msg.payload.time}`;
      const prevRev = this.lastBarRevisionByKey.get(barKey);
      if (prevRev !== undefined && msg.revision <= prevRev) {
        this.droppedDuplicate++;
        return;
      }
      if (prevRev !== undefined) {
        this.lastBarRevisionByKey.delete(barKey);
      } else if (this.lastBarRevisionByKey.size >= this.maxTrackedBarRevisions) {
        const oldest = this.lastBarRevisionByKey.keys().next().value;
        if (oldest !== undefined) {
          this.lastBarRevisionByKey.delete(oldest);
        }
      }
      this.lastBarRevisionByKey.set(barKey, msg.revision);
      this.processedIngress++;
      this.handlers.onBar?.(msg.payload, msg);
      return;
    }

    if (msg.kind === "ingress:heatmap-tail") {
      this.processedIngress++;
      this.handlers.onHeatmapTail?.(msg.payload, msg);
      return;
    }

    this.processedIngress++;
  }

  private handleHistoryMessage(msg: HistoryWorkerMessage): void {
    if (msg.kind === "history:chunk") {
      this.processedHistory++;
      this.handlers.onHistoryChunk?.(msg.payload, msg);
      return;
    }
    if (msg.kind === "history:heatmap-chunk") {
      this.processedHistory++;
      this.handlers.onHeatmapChunk?.(msg.payload, msg);
      return;
    }
    this.processedHistory++;
  }

  private handleMainControlMessage(msg: MainWorkerMessage): void {
    this.processedMain++;

    if (msg.kind === "main:init") {
      this.handlers.onInit?.(msg.payload, msg);
      return;
    }
    if (msg.kind === "main:resize") {
      this.handlers.onResize?.(msg.payload, msg);
      return;
    }
    if (msg.kind === "main:state-update") {
      this.handlers.onStateUpdate?.(msg.payload, msg);
      return;
    }
    if (msg.kind === "main:input") {
      this.inputQueue.enqueue(msg);
      return;
    }
    if (msg.kind === "main:lifecycle") {
      this.handlers.onLifecycle?.(msg.payload, msg);
      return;
    }

    if (msg.kind === "main:capture-request" && this.mainPort) {
      const sendCapture = (
        resolved: Extract<MainWorkerMessage, { kind: "main:capture-response" }>["payload"],
      ): void => {
        if (this.disposed || !this.mainPort) return;
        const transfer = resolved.buffer ? [resolved.buffer] : undefined;
        this.postMainResponse(
          "main:capture-response",
          msg.requestId,
          msg.generation,
          resolved,
          transfer,
        );
      };

      const result = this.handlers.onCapture
        ? this.handlers.onCapture(msg.payload, msg)
        : { ok: false, error: "No capture handler registered" };
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (
          result as Promise<
            Extract<MainWorkerMessage, { kind: "main:capture-response" }>["payload"]
          >
        ).then(
          (resolved) => sendCapture(resolved),
          (err) =>
            sendCapture({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
      } else {
        sendCapture(
          result as Extract<MainWorkerMessage, { kind: "main:capture-response" }>["payload"],
        );
      }
      return;
    }

    if (msg.kind === "main:hit-test-request" && this.mainPort) {
      const result = this.handlers.onHitTest
        ? this.handlers.onHitTest(msg.payload, msg)
        : { hit: false };
      this.postMainResponse("main:hit-test-response", msg.requestId, msg.generation, result);
      return;
    }

    if (msg.kind === "main:tooltip-request" && this.mainPort) {
      const result = this.handlers.onTooltip
        ? this.handlers.onTooltip(msg.payload, msg)
        : { visible: false, x: msg.payload.x, y: msg.payload.y };
      this.postMainResponse("main:tooltip-response", msg.requestId, msg.generation, result);
    }
  }

  private postMainResponse<K extends "main:capture-response" | "main:hit-test-response" | "main:tooltip-response">(
    kind: K,
    requestId: string | undefined,
    generation: number,
    payload: unknown,
    transfer?: Transferable[],
  ): void {
    if (!this.mainPort) return;
    const wireMsg: WorkerEnvelopeBase<"main", K, unknown> = {
      channel: "main",
      kind,
      panelId: this.panelId,
      marketId: this.marketId,
      generation,
      seq: ++this.seq,
      revision: ++this.revision,
      ...(requestId ? { requestId } : {}),
      ack: 1,
      payload,
    };
    if (transfer && transfer.length > 0) {
      this.mainPort.postMessage(wireMsg, transfer);
    } else {
      this.mainPort.postMessage(wireMsg);
    }
  }

  private detachPorts(): void {
    if (this.mainPort) {
      this.mainPort.removeEventListener("message", this.onMainMessage);
    }
    if (this.ingressPort) {
      this.ingressPort.removeEventListener("message", this.onIngressMessage);
    }
    if (this.historyPort) {
      this.historyPort.removeEventListener("message", this.onHistoryMessage);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WorkerChartEndpoint has been disposed.");
    }
  }
}
