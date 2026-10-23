// Private, default-off GPU density prototype for the orderbook heatmap
// (PR-local experiment; not a public feature). It paints the same cells the
// canvas overlay would paint into the Session-owned native GPU frame, above
// the candles and below the annotation surface, so hover/axis/errors stay on
// the annotation canvas. The density scalar field is uploaded as a R32F
// texture with an R8 present-cell mask (core WebGL 2, NEAREST + CLAMP_TO_EDGE
// filtering); a present zero cell stays distinct from an absent bucket.
//
// Cache epochs are deliberately separate:
// - DATA: overlay dataKey + cell values (texture upload only on change)
// - GEOMETRY: cell rects/uv instances (buffer upload only on change)
// - UNIFORM: threshold + ceiling-derived log span (per draw, no retained state)
// - RESOURCE: the owning GL context and allocation sizes (disposed exactly once)
//
// Real hard budgets count GPU textures/buffers plus CPU staging, retained
// copies, the prepared frame lists and live replacement peaks, against 64 MiB
// per chart and a 256 MiB module-wide realm. Any allocation or GL failure
// throws to the caller, which falls back to the legacy annotation path.
import { createProgram } from "../../../../core/engine/gl.js";
import { isPerformanceTelemetryEnabled, recordPerformanceDuration } from "../../../../core/performanceTelemetry.js";
import { HEATMAP_MIN_CEILING_RATIO } from "../../../orderbook/heatmapModel.js";
import { HEATMAP_GPU_FRAG_SRC, HEATMAP_GPU_VERT_SRC } from "./heatmapGpuShaders.js";

/** One density cell rectangle in CSS pixels with its scalar value. */
export interface HeatmapGpuRect {
  x: number;
  yTop: number;
  width: number;
  height: number;
  value: number;
  /**
   * Extension only: index into frame.main whose scalar this extension
   * repaints. The extension owns its own EXT texel, MAIN scalars are never
   * overwritten, and the per-row MAIN -> EXT paint order is preserved.
   */
  sourceMainIndex?: number;
}

/** CPU-prepared frame inputs; produced by OrderbookHeatmapOverlay.prepareGpuCells. */
export interface HeatmapGpuCellFrame {
  main: HeatmapGpuRect[];
  extension: HeatmapGpuRect[];
  ceiling: number;
  threshold: number;
  dataKey: string;
  /**
   * Production prepare only: lease covering the prepared lists' known
   * logical payload, held by the caller while it retains the frame. When
   * present, renderFrame skips its own transient prepared-lists charge so
   * the same objects are never double-accounted. Legacy three-argument
   * frames leave this undefined and keep the transient charge.
   */
  preparedLease?: { release(): void };
}

/** Hard per-chart prototype budget: GPU + CPU staging + retained copies. */
export const HEATMAP_GPU_CHART_BUDGET_BYTES = 64 * 1024 * 1024;
/** Hard module-wide realm budget across every live prototype renderer. */
export const HEATMAP_GPU_MODULE_BUDGET_BYTES = 256 * 1024 * 1024;

/** Module realm accounting: grows/shrinks with real allocations, never on DPR changes. */
let moduleReservedBytes = 0;

const FLOATS_PER_INSTANCE = 7; // rect.x, rect.y, rect.w, rect.h, texel.u, texel.v, alphaScale
const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]); // two triangles
const GRID_MAX_WIDTH = 1024;
const MAX_INSTANCE_BYTES = 64 * 1024 * 1024;
const MAX_GRID_TEXELS = 16 * 1024 * 1024;
/** Known CPU-side bytes per prepared cell (visible entry + rect objects + instance floats), matching the overlay's GPU_PREPARED_CELL_PAYLOAD_BYTES. */
const KNOWN_FRAME_CELL_BYTES = 352;

export class HeatmapGpuRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private unitBuffer: WebGLBuffer | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private densityTexture: WebGLTexture | null = null;
  private validityTexture: WebGLTexture | null = null;
  private uResolution: WebGLUniformLocation | null = null;
  private uThreshold: WebGLUniformLocation | null = null;
  private uLogSpan: WebGLUniformLocation | null = null;
  private uDensity: WebGLUniformLocation | null = null;
  private uValidity: WebGLUniformLocation | null = null;

  private gridWidth = 0;
  private gridHeight = 0;
  private textureReservedTexels = 0;
  private stagingValues: Float32Array | null = null;
  private stagingValidity: Uint8Array | null = null;
  private stagingReservedElements = 0;
  private uploadedValues: Float32Array | null = null;
  private uploadedValidity: Uint8Array | null = null;
  private uploadedDataKey = "";
  private retainedReservedBytes = 0;
  /** Reserved bytes for the retained uploadedInstances CPU copy. */
  private uploadedInstancesReservedBytes = 0;
  private instanceData: Float32Array | null = null;
  private uploadedInstances: Float32Array | null = null;
  private instanceReservedFloats = 0;
  private gpuInstanceCapacityBytes = 0;
  /** Init-only capability read (MAX_TEXTURE_SIZE); never queried per frame. */
  private maxTextureSize = 0;

  /** Bytes reserved in both budgets for this renderer; released exactly once. */
  private reservedBytes = 0;
  /**
   * Bytes reserved for caller-held prepared leases, charged apart from the
   * renderer-owned reservation: dispose() frees only renderer-owned bytes, so
   * external prepared payloads stay charged in both budgets until their owner
   * explicitly releases the lease (which must also work after dispose()).
   */
  private preparedLeaseBytes = 0;
  private disposed = false;

  /**
   * Draw one prepared frame into the current framebuffer, above the already
   * flushed candle layers and strictly inside the plot area. Returns success;
   * on any failure the renderer's resources are disposed and the caller must
   * fall back to the legacy annotation path.
   *
   * With performance telemetry enabled, every call on a live renderer records
   * its CPU time as `chart.gpu.heatmap.render.ms`: validation, uploads and
   * draw submission, not the time the GPU takes to execute the commands.
   */
  renderFrame(gl: WebGL2RenderingContext, frame: HeatmapGpuCellFrame, plot: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): boolean {
    if (this.disposed) return false;
    // No closure, so the frame path allocates nothing extra; disabled
    // telemetry costs one flag read.
    const startedAt = isPerformanceTelemetryEnabled() ? performance.now() : null;
    try {
      return this.submitFrame(gl, frame, plot);
    } finally {
      if (startedAt !== null) recordPerformanceDuration("chart.gpu.heatmap.render.ms", performance.now() - startedAt);
    }
  }

  /** Validates, uploads and draws one frame; `renderFrame` times it. */
  private submitFrame(gl: WebGL2RenderingContext, frame: HeatmapGpuCellFrame, plot: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): boolean {
    const cells = frame.main.length + frame.extension.length;
    if (cells === 0) return true; // successful empty frame (e.g. acknowledged empty books)
    if (!Number.isFinite(cells) || cells > MAX_GRID_TEXELS) return false;
    // Float64 inputs must stay finite through the Float32 texture/attribute
    // upload: a finite 1e40 would become Infinity in the R32F texture.
    const f32 = (n: number): boolean => Number.isFinite(n) && Number.isFinite(Math.fround(n));
    // Positive geometry must stay positive through the Float32 attribute
    // upload, and a positive scalar must not underflow to a present zero.
    const pos = (n: number): boolean => f32(n) && n > 0 && Math.fround(n) > 0;
    const val = (n: number): boolean => f32(n) && n >= 0 && !(n > 0 && Math.fround(n) === 0);
    for (const rect of frame.main) {
      if (!f32(rect.x) || !f32(rect.yTop) || !pos(rect.width) || !pos(rect.height)
        || !val(rect.value)) return false;
    }
    for (const rect of frame.extension) {
      if (!f32(rect.x) || !f32(rect.yTop) || !pos(rect.width) || !pos(rect.height)
        || !val(rect.value)) return false;
      if (rect.sourceMainIndex === undefined || rect.sourceMainIndex < 0
        || rect.sourceMainIndex >= frame.main.length || !Number.isInteger(rect.sourceMainIndex)) return false;
    }
    // A positive threshold/ceiling must survive the Float32 uniform upload:
    // 1e-50 would round to a present zero and silently widen the drawn span.
    // A literal present zero stays accepted, exactly like present cell zeros.
    if (!val(frame.threshold) || !val(frame.ceiling)) return false;
    if (!(plot.width > 0) || !(plot.height > 0)) return false;
    // The prepared frame lists themselves are a known CPU payload: charge
    // both budgets for the lifetime of the frame (transient, released after
    // the draw) instead of counting only renderer-owned allocations. A
    // production prepare already holds an explicit lease (frame.preparedLease)
    // covering the exact same prepared lists, so the transient charge is
    // skipped to avoid double-accounting the same objects.
    const framePayloadBytes = frame.preparedLease === undefined ? cells * KNOWN_FRAME_CELL_BYTES : 0;
    if (framePayloadBytes > 0) {
      if (this.reservedBytes + this.preparedLeaseBytes + framePayloadBytes > HEATMAP_GPU_CHART_BUDGET_BYTES
        || moduleReservedBytes + framePayloadBytes > HEATMAP_GPU_MODULE_BUDGET_BYTES) return false;
      this.reservedBytes += framePayloadBytes;
      moduleReservedBytes += framePayloadBytes;
    }
    try {
      // The texture grid must cover MAIN + EXT texels: extensions own their
      // own texels past the main count, capped by the grid bounds checks.
      this.ensureResources(gl, cells, cells);
      this.uploadData(gl, frame);
      this.uploadInstances(gl, frame);
      this.draw(gl, frame, plot);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "Heatmap GPU prototype budget exceeded") {
        // Transient real-ledger denial: reserve() mutated neither ledger, so
        // the renderer and its initialized resources stay intact. Resource
        // publication inside ensureResources is transactional: a denial never
        // leaves half-initialised program or grid metadata behind, so the
        // retry re-runs the skipped init. Propagate so
        // the caller treats it as per-frame pressure (retry next frame once it
        // clears) instead of a hard GL failure that latches a legacy fallback.
        throw error;
      }
      this.dispose();
      return false;
    } finally {
      this.releaseBytes(framePayloadBytes);
    }
  }

  /**
   * Reserve logical bytes for a caller-prepared payload (the overlay's
   * prepared frame lists) against the SAME per-chart and module-wide ledger
   * as the renderer's own initialized resources, staging, retained copies
   * and prepared reservations. `logicalBytes` must be a finite positive
   * safe integer; anything else (or an over-budget request) returns null
   * without mutating either ledger, so a rejected request never poisons the
   * renderer or later reservations. Works cold, before any GL context is
   * bound. The returned lease's release() is idempotent through its own
   * once-flag (never through clamping), releases exactly the reserved bytes
   * once, and is a no-op after dispose() already freed the reservation.
   */
  reservePreparedPayload(logicalBytes: number): { release(): void } | null {
    if (this.disposed) return null;
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes <= 0) return null;
    if (this.reservedBytes + this.preparedLeaseBytes + logicalBytes > HEATMAP_GPU_CHART_BUDGET_BYTES
      || moduleReservedBytes + logicalBytes > HEATMAP_GPU_MODULE_BUDGET_BYTES) return null;
    this.preparedLeaseBytes += logicalBytes;
    moduleReservedBytes += logicalBytes;
    let released = false;
    return {
      release: () => {
        // Idempotent through the once-flag only, never through clamping.
        // The lease is charged apart from the renderer-owned reservation and
        // stays held across dispose(), so a late owner release subtracts
        // exactly its own bytes from both ledgers, never another owner's.
        if (released) return;
        released = true;
        this.preparedLeaseBytes -= logicalBytes;
        moduleReservedBytes -= logicalBytes;
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl) {
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.unitBuffer) gl.deleteBuffer(this.unitBuffer);
      if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
      if (this.densityTexture) gl.deleteTexture(this.densityTexture);
      if (this.validityTexture) gl.deleteTexture(this.validityTexture);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.vao = null;
    this.unitBuffer = null;
    this.instanceBuffer = null;
    this.densityTexture = null;
    this.validityTexture = null;
    this.program = null;
    this.gl = null;
    this.stagingValues = null;
    this.stagingValidity = null;
    this.uploadedValues = null;
    this.uploadedValidity = null;
    this.uploadedDataKey = "";
    this.instanceData = null;
    this.uploadedInstances = null;
    this.instanceReservedFloats = 0;
    this.gpuInstanceCapacityBytes = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.textureReservedTexels = 0;
    this.stagingReservedElements = 0;
    this.retainedReservedBytes = 0;
    this.maxTextureSize = 0;
    this.releaseReservation();
  }

  private reserve(deltaBytes: number): void {
    if (deltaBytes <= 0) return;
    if (this.reservedBytes + this.preparedLeaseBytes + deltaBytes > HEATMAP_GPU_CHART_BUDGET_BYTES
      || moduleReservedBytes + deltaBytes > HEATMAP_GPU_MODULE_BUDGET_BYTES) {
      throw new Error("Heatmap GPU prototype budget exceeded");
    }
    this.reservedBytes += deltaBytes;
    moduleReservedBytes += deltaBytes;
  }

  private releaseBytes(bytes: number): void {
    if (bytes <= 0) return;
    const chartRelease = Math.min(bytes, this.reservedBytes);
    this.reservedBytes -= chartRelease;
    moduleReservedBytes -= chartRelease;
  }

  private releaseReservation(): void {
    this.releaseBytes(this.reservedBytes);
  }

  private ensureResources(gl: WebGL2RenderingContext, cellCount: number, instanceCount: number): void {
    if (this.gl !== null && this.gl !== gl) this.dispose();
    if (this.disposed) throw new Error("Heatmap GPU renderer disposed during resource init");
    this.gl = gl;

    if (this.maxTextureSize === 0) {
      const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
        throw new Error("Heatmap GPU prototype: MAX_TEXTURE_SIZE unavailable");
      }
      this.maxTextureSize = limit;
    }

    if (!this.program) {
      // Reserve the unit-quad storage before any GL object is created or
      // published: a budget denial aborts with nothing allocated, canonical
      // GL bindings and no published fields, so the same renderer's retry
      // re-runs the full unit upload and attribute init.
      this.reserve(UNIT_QUAD.byteLength);
      const program = createProgram(gl, HEATMAP_GPU_VERT_SRC, HEATMAP_GPU_FRAG_SRC);
      const uResolution = gl.getUniformLocation(program, "u_resolution");
      const uThreshold = gl.getUniformLocation(program, "u_threshold");
      const uLogSpan = gl.getUniformLocation(program, "u_logSpan");
      const uDensity = gl.getUniformLocation(program, "u_density");
      const uValidity = gl.getUniformLocation(program, "u_validity");
      if (!uResolution || !uThreshold || !uLogSpan || !uDensity || !uValidity) {
        gl.deleteProgram(program);
        this.releaseReservation();
        throw new Error("Failed to locate heatmap prototype uniforms");
      }
      const vao = gl.createVertexArray();
      const unitBuffer = gl.createBuffer();
      const instanceBuffer = gl.createBuffer();
      if (!vao || !unitBuffer || !instanceBuffer) {
        // Native allocation returning null is valid WebGL behavior, not an
        // exception: roll back every locally created object exactly once —
        // including the program, which the outer dispose can never reach
        // because these fields were never published — and release the unit
        // reservation so the logical ledger keeps no orphaned charge and a
        // retry re-runs the full unit upload and attribute init.
        gl.deleteProgram(program);
        if (vao) gl.deleteVertexArray(vao);
        if (unitBuffer) gl.deleteBuffer(unitBuffer);
        if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
        this.releaseReservation();
        throw new Error("Failed to create heatmap prototype buffers");
      }
      const aUnit = gl.getAttribLocation(program, "a_unit");
      const aRect = gl.getAttribLocation(program, "a_rect");
      const aTexel = gl.getAttribLocation(program, "a_texel");
      const aAlphaScale = gl.getAttribLocation(program, "a_alphaScale");
      const stride = FLOATS_PER_INSTANCE * 4;
      try {
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, unitBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aUnit);
        gl.vertexAttribPointer(aUnit, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, 1, gl.DYNAMIC_DRAW); // sized on first real upload
        gl.enableVertexAttribArray(aRect);
        gl.vertexAttribPointer(aRect, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(aRect, 1);
        gl.enableVertexAttribArray(aTexel);
        gl.vertexAttribPointer(aTexel, 2, gl.FLOAT, false, stride, 16);
        gl.vertexAttribDivisor(aTexel, 1);
        gl.enableVertexAttribArray(aAlphaScale);
        // 7-float interleave: x, y, w, h, u, v, alpha -> alpha byte offset is 24.
        gl.vertexAttribPointer(aAlphaScale, 1, gl.FLOAT, false, stride, 24);
        gl.vertexAttribDivisor(aAlphaScale, 1);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      } catch (uploadError) {
        // A controlled guard probe may throw inside bufferData after all four
        // objects were created and bound: transactionally roll back every
        // object this path created — exactly once each — restore canonical
        // VAO/ARRAY_BUFFER bindings and release the unit reservation, then
        // rethrow. Nothing was published, so the outer dispose cannot double
        // delete these locals and a retry re-runs the full init.
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(unitBuffer);
        gl.deleteBuffer(instanceBuffer);
        gl.deleteProgram(program);
        this.releaseReservation();
        throw uploadError;
      }
      // Publish the program fields only after the unit storage upload and
      // every attribute pointer completed: a half-initialised renderer must
      // never make a retry skip them and still claim a drawn frame.
      this.program = program;
      this.uResolution = uResolution;
      this.uThreshold = uThreshold;
      this.uLogSpan = uLogSpan;
      this.uDensity = uDensity;
      this.uValidity = uValidity;
      this.vao = vao;
      this.unitBuffer = unitBuffer;
      this.instanceBuffer = instanceBuffer;
    }

    const gridWidth = Math.min(cellCount, GRID_MAX_WIDTH);
    const gridHeight = Math.ceil(cellCount / gridWidth);
    if (gridWidth <= 0 || gridHeight <= 0 || gridWidth * gridHeight > MAX_GRID_TEXELS
      || gridWidth > this.maxTextureSize || gridHeight > this.maxTextureSize) {
      throw new Error("Heatmap GPU prototype grid out of bounds");
    }
    if (gridWidth !== this.gridWidth || gridHeight !== this.gridHeight) {
      // Retained copies describe the old grid only: drop them (and their
      // reservation) before the replacement allocation.
      this.releaseBytes(this.retainedReservedBytes);
      this.retainedReservedBytes = 0;
      this.uploadedValues = null;
      this.uploadedValidity = null;
      this.uploadedDataKey = "";
      const texels = gridWidth * gridHeight;
      // Replacement peak: the driver may transiently hold the old and the new
      // storage together, so reserve the full new size while the old one is
      // still counted, then release the old size after the replacement.
      const oldTexelBytes = this.textureReservedTexels * 5;
      const newTexelBytes = texels * 5; // R32F (4B) + R8 (1B)
      // Reserve before creating or rebinding anything: a budget denial
      // aborts with no new texture objects, canonical GL bindings and no
      // published grid metadata, so the retry re-runs the full storage
      // allocation instead of skipping texImage2D on stale dimensions.
      this.reserve(newTexelBytes);
      if (!this.densityTexture) this.densityTexture = gl.createTexture();
      if (!this.validityTexture) this.validityTexture = gl.createTexture();
      if (!this.densityTexture || !this.validityTexture) throw new Error("Failed to create heatmap prototype textures");
      gl.bindTexture(gl.TEXTURE_2D, this.densityTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, gridWidth, gridHeight, 0, gl.RED, gl.FLOAT, null);
      gl.bindTexture(gl.TEXTURE_2D, this.validityTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gridWidth, gridHeight, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      // Publish the grid metadata only after BOTH texImage2D stores
      // completed: half-published dimensions must never make a retry skip
      // the storage allocation for a grid it never actually created.
      this.gridWidth = gridWidth;
      this.gridHeight = gridHeight;
      this.textureReservedTexels = texels;
      this.releaseBytes(oldTexelBytes);
    }

    const neededStaging = gridWidth * gridHeight;
    if (!this.stagingValues || this.stagingValues.length < neededStaging) {
      const elements = Math.max(neededStaging, 4096);
      // Replacement peak: the full new size is reserved while the old arrays
      // are still referenced; the old size is released after the swap.
      const oldBytes = this.stagingReservedElements * 5;
      const newBytes = elements * 5; // CPU staging: R32F + R8
      this.reserve(newBytes);
      this.stagingReservedElements = elements;
      this.stagingValues = new Float32Array(elements);
      this.stagingValidity = new Uint8Array(elements);
      this.releaseBytes(oldBytes);
    }
    if (!this.stagingValidity) throw new Error("Heatmap GPU staging missing");

    const instanceBytes = instanceCount * FLOATS_PER_INSTANCE * 4;
    if (instanceBytes > MAX_INSTANCE_BYTES) throw new Error("Heatmap GPU prototype instance buffer out of budget");
    if (!this.instanceData || this.instanceData.length < instanceCount * FLOATS_PER_INSTANCE) {
      const capacity = Math.max(instanceCount * FLOATS_PER_INSTANCE, 4096);
      // CPU staging plus the retained upload copy, at replacement peak.
      const oldBytes = this.instanceReservedFloats * 8;
      const newBytes = capacity * 8;
      this.reserve(newBytes);
      this.instanceReservedFloats = capacity;
      this.instanceData = new Float32Array(capacity);
      this.releaseBytes(this.uploadedInstancesReservedBytes);
      this.uploadedInstancesReservedBytes = 0;
      this.uploadedInstances = null;
      this.releaseBytes(oldBytes);
    }
  }

  private uploadData(gl: WebGL2RenderingContext, frame: HeatmapGpuCellFrame): void {
    const staging = this.stagingValues!;
    const validity = this.stagingValidity!;
    const mainCount = frame.main.length;
    staging.fill(0);
    validity.fill(0);
    // MAIN scalars live in their own texels and are never overwritten; each
    // extension duplicates its source main scalar into its own EXT texel so
    // historical/live values stay correct wherever the live cells sit.
    for (let i = 0; i < mainCount; i++) {
      staging[i] = frame.main[i].value;
      validity[i] = 255; // normalized R8 samples 1.0, passing the shader's 0.5 present gate
    }
    for (let j = 0; j < frame.extension.length; j++) {
      const rect = frame.extension[j];
      const source = rect.sourceMainIndex!;
      staging[mainCount + j] = frame.main[source].value;
      validity[mainCount + j] = 255;
    }

    // Re-upload only when the data epoch changed: key, layout size or any
    // value/validity texel (elementwise compare, no hashing, no per-frame upload).
    const uploaded = this.uploadedValues;
    const uploadedMask = this.uploadedValidity;
    let needsUpload = !uploaded || !uploadedMask || uploaded.length !== staging.length
      || uploadedMask.length !== validity.length || frame.dataKey !== this.uploadedDataKey;
    if (!needsUpload && uploaded && uploadedMask) {
      for (let i = 0; i < staging.length; i++) {
        if (uploaded[i] !== staging[i] || uploadedMask[i] !== validity[i]) { needsUpload = true; break; }
      }
    }
    if (!needsUpload) return;
    gl.bindTexture(gl.TEXTURE_2D, this.densityTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridWidth, this.gridHeight, gl.RED, gl.FLOAT, staging);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.validityTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridWidth, this.gridHeight, gl.RED, gl.UNSIGNED_BYTE, validity);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const retainedNeeded = staging.length * 5; // retained copy of what the GPU holds
    if (this.retainedReservedBytes !== retainedNeeded) {
      // Full new reservation first (old copies still alive = replacement peak).
      this.reserve(retainedNeeded);
      const oldRetained = this.retainedReservedBytes;
      this.retainedReservedBytes = retainedNeeded;
      if (!this.uploadedValues || this.uploadedValues.length !== staging.length) {
        this.uploadedValues = new Float32Array(staging.length);
      }
      if (!this.uploadedValidity || this.uploadedValidity.length !== validity.length) {
        this.uploadedValidity = new Uint8Array(validity.length);
      }
      this.releaseBytes(oldRetained);
    }
    this.uploadedValues!.set(staging);
    this.uploadedValidity!.set(validity);
    this.uploadedDataKey = frame.dataKey;
  }

  private uploadInstances(gl: WebGL2RenderingContext, frame: HeatmapGpuCellFrame): void {
    const data = this.instanceData!;
    const total = frame.main.length + frame.extension.length;
    const width = this.gridWidth;
    const height = this.gridHeight;
    let offset = 0;
    const writeRect = (rect: HeatmapGpuRect, cellIndex: number, alphaScale: number): void => {
      const col = cellIndex % width;
      const row = Math.floor(cellIndex / width);
      data[offset] = rect.x;
      data[offset + 1] = rect.yTop;
      data[offset + 2] = rect.width;
      data[offset + 3] = rect.height;
      data[offset + 4] = (col + 0.5) / width;
      data[offset + 5] = (row + 0.5) / height;
      data[offset + 6] = alphaScale;
      offset += FLOATS_PER_INSTANCE;
    };
    // Preserve the canvas paint order: each row's MAIN rect is immediately
    // followed by its own EXT rect, never all MAINs then all EXTs, so
    // overlapping sub-pixel columns composite exactly like the CPU overlay.
    let nextExt = 0;
    for (let i = 0; i < frame.main.length; i++) {
      writeRect(frame.main[i], i, 1);
      while (nextExt < frame.extension.length && frame.extension[nextExt].sourceMainIndex === i) {
        writeRect(frame.extension[nextExt], frame.main.length + nextExt, 0.45);
        nextExt++;
      }
    }
    if (nextExt !== frame.extension.length) throw new Error("Heatmap GPU extension source index out of order");
    if (offset !== total * FLOATS_PER_INSTANCE) throw new Error("Heatmap GPU instance accounting mismatch");

    const view = data.subarray(0, offset);
    const uploaded = this.uploadedInstances;
    if (uploaded && uploaded.length === view.length) {
      let same = true;
      for (let i = 0; i < view.length; i++) {
        if (uploaded[i] !== view[i]) { same = false; break; }
      }
      if (same) {
        // No re-upload, but the draw contract still must hold.
        if (view.byteLength > this.gpuInstanceCapacityBytes) {
          throw new Error("Heatmap GPU instance buffer smaller than the draw contract");
        }
        return;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (view.byteLength > this.gpuInstanceCapacityBytes) {
      const oldBytes = this.gpuInstanceCapacityBytes;
      this.reserve(view.byteLength); // replacement peak: old + new GPU storage
      this.gpuInstanceCapacityBytes = view.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, view.byteLength, gl.DYNAMIC_DRAW);
      this.releaseBytes(oldBytes);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (view.byteLength > this.gpuInstanceCapacityBytes) {
      throw new Error("Heatmap GPU instance buffer smaller than the draw contract");
    }
    if (!this.uploadedInstances || this.uploadedInstances.length !== view.length) {
      // Replacement peak: charge the new retained copy while the old copy is
      // still referenced, then release the old charge after the swap.
      const oldRetainedBytes = this.uploadedInstancesReservedBytes;
      this.reserve(view.byteLength);
      this.uploadedInstancesReservedBytes = view.byteLength;
      this.uploadedInstances = new Float32Array(view.length);
      this.releaseBytes(oldRetainedBytes);
    }
    this.uploadedInstances.set(view);
  }

  private draw(gl: WebGL2RenderingContext, frame: HeatmapGpuCellFrame, plot: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): void {
    const canvas = gl.canvas as HTMLCanvasElement;
    const ownerWindow = canvas.ownerDocument?.defaultView;
    const dpr = ownerWindow?.devicePixelRatio || 1;
    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    if (!(bufferWidth > 0) || !(bufferHeight > 0) || !(dpr > 0)) throw new Error("Heatmap GPU draw: invalid buffer");

    const threshold = frame.threshold;
    const ceiling = threshold > 0 ? Math.max(frame.ceiling, threshold * HEATMAP_MIN_CEILING_RATIO) : threshold;
    if (!Number.isFinite(Math.fround(threshold)) || !Number.isFinite(Math.fround(ceiling))) {
      throw new Error("Heatmap GPU draw: non-finite uniforms");
    }
    const logSpan = threshold > 0 ? Math.log10(ceiling / threshold) : 1;
    if (!Number.isFinite(logSpan)) throw new Error("Heatmap GPU draw: invalid log span");
    const instanceCount = frame.main.length + frame.extension.length;

    // Preflight the scissor and the instance-buffer contract BEFORE any
    // program/texture/blend state is touched, so a rejected frame leaves the
    // QuadBatch GL state completely untouched.
    const scissorX = Math.round(plot.left * dpr);
    const scissorY = bufferHeight - Math.round((plot.top + plot.height) * dpr);
    const scissorW = Math.round(plot.width * dpr);
    const scissorH = Math.round(plot.height * dpr);
    if (!(scissorW > 0) || !(scissorH > 0) || scissorX < 0 || scissorY < 0
      || scissorX + scissorW > bufferWidth || scissorY + scissorH > bufferHeight) {
      throw new Error("Heatmap GPU draw: plot bounds outside the framebuffer");
    }
    if (instanceCount * FLOATS_PER_INSTANCE * 4 > this.gpuInstanceCapacityBytes) {
      throw new Error("Heatmap GPU draw: instance buffer smaller than the draw contract");
    }

    gl.viewport(0, 0, bufferWidth, bufferHeight);
    try {
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniform2f(this.uResolution, bufferWidth / dpr, bufferHeight / dpr);
      gl.uniform1f(this.uThreshold, threshold);
      gl.uniform1f(this.uLogSpan, logSpan);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.densityTexture);
      gl.uniform1i(this.uDensity, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.validityTexture);
      gl.uniform1i(this.uValidity, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

      // Known stale raster state from earlier GPU layers would silently drop
      // every fragment (no GL error, draw still "succeeds"): reset the
      // cull/depth/stencil/rasterizer-discard state explicitly before
      // drawing, without hot capability queries.
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.enable(gl.BLEND);
      // Keep the framebuffer opaque (alpha 255) exactly like the canvas overlay:
      // color blends with source alpha, destination alpha stays 1.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.scissor(scissorX, scissorY, scissorW, scissorH);
      gl.enable(gl.SCISSOR_TEST);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
    } finally {
      // Explicit state exit back to the FootprintRenderer/QuadBatch contract,
      // guaranteed also on exceptions: no VAO/program/buffer/texture/scissor
      // or pixel-store side effects left behind.
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    }
  }
}
