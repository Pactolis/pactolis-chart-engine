import { ChartChange } from "../scene/chartScene.js";

/** A pass names its semantic dependencies independently of its physical canvas. */
export interface ChartRenderPass {
  readonly id: string;
  readonly interests: ChartChange;
  readonly captureMain?: boolean;
}

const STATIC_ANNOTATION = ChartChange.All & ~ChartChange.DataTail;
export function annotationPass(id: string, live = false): ChartRenderPass {
  if (live) return { id, interests: ChartChange.All };
  if (id === "closed-tpo") return { id, interests: STATIC_ANNOTATION, captureMain: true };
  return { id, interests: ["axis", "drawings", "strategy-levels", "naked-poc", "reference-levels", "closed-footprint-text"].includes(id)
    ? STATIC_ANNOTATION : ChartChange.All };
}

const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
interface Entry<T> { canvas: HTMLCanvasElement; effects: T; key: string; valid: boolean }

/** Bounded per-overlay bitmaps; every non-tail change invalidates retained output. */
export class AnnotationPassCache<T> {
  private entries = new Map<string, Entry<T>>();
  private frameKey = "";
  private sameGeometry = false;
  private bytes = 0;

  begin(changes: ChartChange, key: string): void {
    this.sameGeometry = key === this.frameKey;
    if (changes !== ChartChange.DataTail || !this.sameGeometry) {
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
    changes: ChartChange, draw: (target: CanvasRenderingContext2D) => T, replay: (effects: T) => void): "hit" | "miss" | false {
    const retained = this.entries.get(pass.id);
    if (changes === ChartChange.None || (pass.interests & ChartChange.DataTail) !== 0) {
      if (retained) retained.valid = false;
      return false;
    }
    if (changes === ChartChange.DataTail && retained?.valid && retained.key === key) {
      replay(retained.effects);
      this.blit(ctx, retained.canvas);
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

  private blit(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
  }
}
