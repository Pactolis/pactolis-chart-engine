import { incrementPerformanceCounter, isPerformanceTelemetryEnabled } from "../performanceTelemetry.js";

export type ScratchLeaseState = "leased" | "returned" | "detached" | "disposed";

export interface TypedArrayConstructor<T extends ArrayBufferView> {
  readonly BYTES_PER_ELEMENT: number;
  new (length: number): T;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): T;
}

export interface TypedArrayPoolOptions {
  /** Maximum number of idle buffers retained in the pool. */
  maxEntries?: number;
  /** Maximum total byte capacity of idle buffers retained in the pool. */
  maxBytes?: number;
}

interface PooledEntry {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly length: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function recordCounter(name: "memory.pool.hit" | "memory.pool.alloc" | "memory.pool.evict"): void {
  if (isPerformanceTelemetryEnabled()) {
    incrementPerformanceCounter(name);
  }
}

/**
 * Explicit ownership handle for a typed-array scratch buffer leased from a
 * `TypedArrayPool`. Guards against use-after-release, double-free, and
 * post-transfer access on detached `ArrayBuffer`s.
 */
export class ScratchBufferLease<T extends ArrayBufferView> {
  private _state: ScratchLeaseState = "leased";
  private readonly _view: T;
  private readonly _initialByteLength: number;
  private readonly onRelease: (lease: ScratchBufferLease<T>) => void;
  private readonly onDetach: (lease: ScratchBufferLease<T>) => void;

  /** @internal */
  constructor(
    view: T,
    onRelease: (lease: ScratchBufferLease<T>) => void,
    onDetach: (lease: ScratchBufferLease<T>) => void,
  ) {
    this._view = view;
    this._initialByteLength = view.byteLength;
    this.onRelease = onRelease;
    this.onDetach = onDetach;
  }

  get state(): ScratchLeaseState {
    return this._state;
  }

  get byteLength(): number {
    return this._view.byteLength;
  }

  private isUnderlyingBufferDetached(): boolean {
    return (
      (this._view.buffer as { detached?: boolean }).detached === true ||
      (this._initialByteLength > 0 && this._view.buffer.byteLength === 0)
    );
  }

  /**
   * Returns the leased typed-array view while owned. Throws if the lease has
   * been returned, detached for worker transfer, or disposed, or if its
   * underlying `ArrayBuffer` was detached externally.
   */
  get view(): T {
    if (this._state !== "leased") {
      throw new Error(`Cannot access scratch buffer lease in state "${this._state}"`);
    }
    if (this.isUnderlyingBufferDetached()) {
      this._state = "detached";
      this.onDetach(this);
      throw new Error("Cannot access scratch buffer lease: underlying ArrayBuffer is detached");
    }
    return this._view;
  }

  /** Returns the buffer to its originating pool. Throws on double-free or detached/disposed leases. */
  release(): void {
    if (this._state !== "leased") {
      throw new Error(`Cannot release scratch buffer lease: already ${this._state}`);
    }
    if (this.isUnderlyingBufferDetached()) {
      this._state = "detached";
      this.onDetach(this);
      throw new Error("Cannot release scratch buffer lease: underlying ArrayBuffer is detached");
    }
    this.onRelease(this);
  }

  /**
   * Transfers ownership of the underlying `ArrayBuffer` (e.g. for `postMessage`
   * transfer lists). Marks the lease `"detached"` so any further access or
   * `release()` throws deterministically.
   */
  detachForTransfer(): ArrayBuffer {
    if (this._state !== "leased") {
      throw new Error(`Cannot detach scratch buffer lease in state "${this._state}"`);
    }
    const buffer = this._view.buffer;
    if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) {
      throw new Error("Cannot detach SharedArrayBuffer for transfer");
    }
    if (this.isUnderlyingBufferDetached()) {
      this._state = "detached";
      this.onDetach(this);
      throw new Error("Cannot detach scratch buffer lease: underlying ArrayBuffer is already detached");
    }
    this._state = "detached";
    this.onDetach(this);
    return buffer as ArrayBuffer;
  }

  /** @internal */
  _rawView(): T {
    return this._view;
  }

  /** @internal */
  _isUnderlyingBufferDetached(): boolean {
    return this.isUnderlyingBufferDetached();
  }

  /** @internal */
  _markState(next: Exclude<ScratchLeaseState, "leased">): void {
    this._state = next;
  }
}

/**
 * Bounded typed-array scratch pool with explicit lease ownership, worker
 * transfer detachment/re-admission, and performance-telemetry counters.
 */
export class TypedArrayPool<T extends ArrayBufferView> {
  private readonly Ctor: TypedArrayConstructor<T>;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly pooled: PooledEntry[] = [];
  private readonly activeLeases = new Set<ScratchBufferLease<T>>();
  private _pooledBytes = 0;
  private _disposed = false;

  constructor(Ctor: TypedArrayConstructor<T>, options: TypedArrayPoolOptions = {}) {
    this.Ctor = Ctor;
    const rawEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const rawBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = Number.isFinite(rawEntries) ? Math.max(0, Math.floor(rawEntries)) : DEFAULT_MAX_ENTRIES;
    this.maxBytes = Number.isFinite(rawBytes) ? Math.max(0, Math.floor(rawBytes)) : DEFAULT_MAX_BYTES;
  }

  get pooledEntries(): number {
    return this.pooled.length;
  }

  get pooledBytes(): number {
    return this._pooledBytes;
  }

  get activeLeaseCount(): number {
    return this.activeLeases.size;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Acquires a `ScratchBufferLease<T>` of at least `minLength` elements.
   * Reuses the smallest pooled buffer that fits `minLength` when available.
   */
  acquire(minLength: number): ScratchBufferLease<T> {
    if (this._disposed) {
      throw new Error("Cannot acquire from a disposed TypedArrayPool");
    }
    if (!Number.isFinite(minLength) || minLength < 0) {
      throw new RangeError(`Invalid typed-array length: ${minLength}`);
    }
    const targetLength = Math.floor(minLength);

    let bestIndex = -1;
    let bestLength = Infinity;
    for (let i = 0; i < this.pooled.length; i++) {
      const entry = this.pooled[i];
      if (entry.length >= targetLength && entry.length < bestLength) {
        bestIndex = i;
        bestLength = entry.length;
        if (bestLength === targetLength) break;
      }
    }

    let view: T;
    if (bestIndex >= 0) {
      const [entry] = this.pooled.splice(bestIndex, 1);
      this._pooledBytes -= entry.byteLength;
      view = new this.Ctor(entry.buffer, 0, targetLength);
      recordCounter("memory.pool.hit");
    } else {
      view = new this.Ctor(targetLength);
      recordCounter("memory.pool.alloc");
    }

    const lease = new ScratchBufferLease<T>(
      view,
      (target) => this.release(target),
      (target) => {
        this.activeLeases.delete(target);
      },
    );
    this.activeLeases.add(lease);
    return lease;
  }

  /** Releases a lease back to the pool. Throws on double-free or detached leases. */
  release(lease: ScratchBufferLease<T>): void {
    if (lease.state !== "leased") {
      throw new Error(`Cannot release scratch buffer lease: already ${lease.state}`);
    }
    this.activeLeases.delete(lease);

    if (this._disposed) {
      lease._markState("disposed");
      return;
    }

    const rawView = lease._rawView();
    const buffer = rawView.buffer;
    if (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer) {
      lease._markState("returned");
      return;
    }
    if (lease._isUnderlyingBufferDetached()) {
      lease._markState("detached");
      throw new Error("Cannot release scratch buffer lease: underlying ArrayBuffer is detached");
    }

    lease._markState("returned");
    this.admitBuffer(buffer as ArrayBuffer);
  }

  /**
   * Re-admits a transferred `ArrayBuffer` returned from a worker thread back
   * into the pool, enforcing pool bounds and detached-buffer validation.
   */
  recycleReturnedBuffer(buffer: ArrayBuffer): boolean {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("recycleReturnedBuffer expects an ArrayBuffer");
    }
    if (buffer.byteLength === 0) {
      throw new Error("Cannot recycle detached ArrayBuffer");
    }
    if (buffer.byteLength % this.Ctor.BYTES_PER_ELEMENT !== 0) {
      throw new Error(
        `Returned buffer byteLength (${buffer.byteLength}) is not aligned to element size (${this.Ctor.BYTES_PER_ELEMENT})`,
      );
    }
    if (this._disposed) {
      return false;
    }
    return this.admitBuffer(buffer);
  }

  /** Clears all pooled buffers and marks any outstanding leases as disposed. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.pooled.length = 0;
    this._pooledBytes = 0;
    for (const lease of this.activeLeases) {
      lease._markState("disposed");
    }
    this.activeLeases.clear();
  }

  private admitBuffer(buffer: ArrayBuffer): boolean {
    const byteLength = buffer.byteLength;
    if (this.maxEntries <= 0 || byteLength > this.maxBytes) {
      recordCounter("memory.pool.evict");
      return false;
    }

    while (this.pooled.length >= this.maxEntries || this._pooledBytes + byteLength > this.maxBytes) {
      const evicted = this.pooled.shift();
      if (!evicted) break;
      this._pooledBytes -= evicted.byteLength;
      recordCounter("memory.pool.evict");
    }

    this.pooled.push({
      buffer,
      byteLength,
      length: Math.floor(byteLength / this.Ctor.BYTES_PER_ELEMENT),
    });
    this._pooledBytes += byteLength;
    return true;
  }
}
