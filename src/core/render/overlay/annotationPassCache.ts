import { ChartChange } from "../scene/chartScene.js";

/** A pass names its semantic dependencies independently of its physical canvas. */
export interface ChartRenderPass {
  readonly id: string;
  readonly interests: ChartChange;
  readonly captureMain?: boolean;
}

const STATIC_ANNOTATION = ChartChange.All & ~(ChartChange.DataTail | ChartChange.Interaction);

export function isCachePreservingChange(changes: ChartChange): boolean {
  return changes !== ChartChange.None && (changes & ~(ChartChange.DataTail | ChartChange.Interaction)) === 0;
}
export function annotationPass(id: string, live = false): ChartRenderPass {
  if (live) return { id, interests: ChartChange.All };
  if (id === "closed-tpo") return { id, interests: STATIC_ANNOTATION, captureMain: true };
  return { id, interests: ["axis", "drawings", "strategy-levels", "naked-poc", "reference-levels", "closed-footprint-text"].includes(id)
    ? STATIC_ANNOTATION : ChartChange.All };
}

const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
interface Entry<T> { canvas: HTMLCanvasElement; effects: T; key: string; valid: boolean }

export interface AnnotationDirtyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY_DIRTY_RECT: AnnotationDirtyRect = { x: 0, y: 0, width: 0, height: 0 };

/** Align a logical CSS-pixel dirty rectangle to device pixels with AA padding, clamped to canvas bounds. */
export function alignDirtyRectToDevicePixels(
  rect: AnnotationDirtyRect,
  dpr: number,
  canvasW: number,
  canvasH: number,
  padPx = 2,
): AnnotationDirtyRect {
  if (
    !Number.isFinite(dpr) || dpr <= 0 ||
    !Number.isFinite(canvasW) || canvasW <= 0 ||
    !Number.isFinite(canvasH) || canvasH <= 0 ||
    !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
    rect.width <= 0 || rect.height <= 0
  ) {
    return EMPTY_DIRTY_RECT;
  }
  const pad = Math.max(0, Math.ceil(Number.isFinite(padPx) ? padPx : 0));
  const x0 = Math.max(0, Math.floor(rect.x * dpr) - pad);
  const y0 = Math.max(0, Math.floor(rect.y * dpr) - pad);
  const x1 = Math.min(canvasW, Math.ceil((rect.x + rect.width) * dpr) + pad);
  const y1 = Math.min(canvasH, Math.ceil((rect.y + rect.height) * dpr) + pad);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return EMPTY_DIRTY_RECT;
  return { x: x0, y: y0, width, height };
}

/** Compute the bounding union of two dirty rectangles, ignoring empty inputs. */
export function unionDirtyRects(a: AnnotationDirtyRect, b: AnnotationDirtyRect): AnnotationDirtyRect {
  const aEmpty = !Number.isFinite(a.width) || !Number.isFinite(a.height) || a.width <= 0 || a.height <= 0;
  const bEmpty = !Number.isFinite(b.width) || !Number.isFinite(b.height) || b.width <= 0 || b.height <= 0;
  if (aEmpty && bEmpty) return EMPTY_DIRTY_RECT;
  if (aEmpty) return { x: b.x, y: b.y, width: b.width, height: b.height };
  if (bEmpty) return { x: a.x, y: a.y, width: a.width, height: a.height };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Return true when the dirty rectangle exceeds the maximum partial-redraw area ratio or canvas bounds are invalid. */
export function shouldFallbackToFullRedraw(
  rect: AnnotationDirtyRect,
  canvasW: number,
  canvasH: number,
  maxAreaRatio = 0.45,
): boolean {
  if (!Number.isFinite(canvasW) || !Number.isFinite(canvasH) || canvasW <= 0 || canvasH <= 0) return true;
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 0 || rect.height < 0) return true;
  const totalArea = canvasW * canvasH;
  return (rect.width * rect.height) / totalArea > maxAreaRatio;
}

/** Bounded per-overlay bitmaps; every non-tail change invalidates retained output. */
export class AnnotationPassCache<T> {
  private entries = new Map<string, Entry<T>>();
  private frameKey = "";
  private sameGeometry = false;
  private bytes = 0;

  isSameGeometry(): boolean {
    return this.sameGeometry;
  }

  canHit(pass: ChartRenderPass, key: string, changes: ChartChange): boolean {
    if (!isCachePreservingChange(changes) || !this.sameGeometry) return false;
    if ((pass.interests & changes) !== 0) return false;
    const retained = this.entries.get(pass.id);
    return Boolean(retained?.valid && retained.key === key);
  }

  begin(changes: ChartChange, key: string): void {
    this.sameGeometry = key === this.frameKey;
    if (!isCachePreservingChange(changes) || !this.sameGeometry) {
      for (const entry of this.entries.values()) entry.valid = false;
    }
    this.frameKey = key;
  }

  clear(): void {
    for (const { canvas } of this.entries.values()) { canvas.width = 0; canvas.height = 0; }
    this.entries.clear();
    this.frameKey = "";
    this.sameGeometry = false;
    this.bytes = 0;
  }

  render(ctx: CanvasRenderingContext2D, pass: ChartRenderPass, key: string,
    changes: ChartChange, draw: (target: CanvasRenderingContext2D) => T, replay: (effects: T) => void,
    dirtyRect?: AnnotationDirtyRect): "hit" | "miss" | false {
    const retained = this.entries.get(pass.id);
    if (changes === ChartChange.None || (pass.interests & ChartChange.DataTail) !== 0) {
      if (retained) retained.valid = false;
      return false;
    }
    if (isCachePreservingChange(changes) && (pass.interests & changes) === 0 && retained?.valid && retained.key === key) {
      replay(retained.effects);
      if (dirtyRect) this.blitRegion(ctx, retained.canvas, dirtyRect);
      else this.blit(ctx, retained.canvas);
      return "hit";
    }
    // A moving viewport cannot reuse a capture on the following frame.
    if (pass.captureMain && !this.sameGeometry) return false;
    const { canvas } = ctx;
    const required = canvas.width * canvas.height * 4;
    const previousBytes = retained ? retained.canvas.width * retained.canvas.height * 4 : 0;
    // Reserve one bitmap for the axis pass, which is last in scene order. At
    // high DPR, earlier static layers must not consume its whole cache budget.
    const reserve = pass.id === "axis" || this.entries.has("axis") ? 0 : required;
    if (!canvas.ownerDocument?.createElement || !ctx.getTransform || required + reserve > MAX_RETAINED_BYTES - this.bytes + previousBytes) return false;
    // Reuse each pass's own backing store during full/history frames. Repeated
    // streaming-history invalidations must not allocate fresh full-size canvases.
    const bitmap = retained?.canvas ?? canvas.ownerDocument.createElement("canvas");
    if (bitmap.width !== canvas.width) bitmap.width = canvas.width;
    if (bitmap.height !== canvas.height) bitmap.height = canvas.height;
    const target = bitmap.getContext("2d");
    if (!target) return false;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, bitmap.width, bitmap.height);
    let effects: T;
    if (pass.captureMain) {
      // This pass owns the initially empty surface. Capture the original paint
      // so text rasterization and fractional edges match the main context.
      effects = draw(ctx);
      target.drawImage(canvas, 0, 0);
    } else {
      const tx = ctx.getTransform();
      target.setTransform(tx.a, tx.b, tx.c, tx.d, tx.e, tx.f);
      effects = draw(target);
      this.blit(ctx, bitmap);
    }
    this.entries.set(pass.id, { canvas: bitmap, effects, key, valid: true });
    this.bytes += required - previousBytes;
    return "miss";
  }

  /** Blit a device-pixel sub-rectangle from a retained bitmap onto ctx, clamped to canvas bounds. */
  blitRegion(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, rect: AnnotationDirtyRect): void {
    const maxW = Math.min(ctx.canvas.width, bitmap.width);
    const maxH = Math.min(ctx.canvas.height, bitmap.height);
    if (maxW <= 0 || maxH <= 0) return;
    const sx = Math.max(0, Math.floor(rect.x));
    const sy = Math.max(0, Math.floor(rect.y));
    const ex = Math.min(maxW, Math.ceil(rect.x + rect.width));
    const ey = Math.min(maxH, Math.ceil(rect.y + rect.height));
    const sw = ex - sx;
    const sh = ey - sy;
    if (sw <= 0 || sh <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
  }

  private blit(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
  }
}
