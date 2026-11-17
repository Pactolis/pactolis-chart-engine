import { ChartChange } from "../scene/chartScene.js";

/** A pass names its semantic dependencies independently of its physical canvas. */
export interface ChartRenderPass {
  readonly id: string;
  readonly interests: ChartChange;
}

const STATIC_ANNOTATION = ChartChange.All & ~ChartChange.DataTail;
export function annotationPass(id: string): ChartRenderPass {
  return { id, interests: ["axis", "drawings", "strategy-levels", "naked-poc", "reference-levels", "closed-footprint-text"].includes(id)
    ? STATIC_ANNOTATION : ChartChange.All };
}

const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
interface Entry<T> { canvas: HTMLCanvasElement; effects: T }

/** Bounded per-overlay bitmaps; every non-tail change invalidates retained output. */
export class AnnotationPassCache<T> {
  private entries = new Map<string, Entry<T>>();
  private frameKey = "";
  private bytes = 0;

  begin(changes: ChartChange, key: string): void {
    if (changes !== ChartChange.DataTail || key !== this.frameKey) this.clear();
    this.frameKey = key;
  }

  clear(): void {
    for (const { canvas } of this.entries.values()) { canvas.width = 0; canvas.height = 0; }
    this.entries.clear();
    this.bytes = 0;
  }

  render(ctx: CanvasRenderingContext2D, pass: ChartRenderPass, key: string,
    changes: ChartChange, draw: (target: CanvasRenderingContext2D) => T, replay: (effects: T) => void): boolean {
    if (changes === ChartChange.None || (pass.interests & ChartChange.DataTail) !== 0) return false;
    const entryKey = `${pass.id}:${key}`;
    const retained = changes === ChartChange.DataTail ? this.entries.get(entryKey) : undefined;
    if (retained) {
      replay(retained.effects);
      this.blit(ctx, retained.canvas);
      return true;
    }
    const { canvas } = ctx;
    const required = canvas.width * canvas.height * 4;
    if (!canvas.ownerDocument?.createElement || !ctx.getTransform || required > MAX_RETAINED_BYTES - this.bytes) return false;
    const bitmap = canvas.ownerDocument.createElement("canvas");
    bitmap.width = canvas.width;
    bitmap.height = canvas.height;
    const target = bitmap.getContext("2d");
    if (!target) return false;
    const tx = ctx.getTransform();
    target.setTransform(tx.a, tx.b, tx.c, tx.d, tx.e, tx.f);
    for (const [oldKey, oldEntry] of this.entries) {
      if (oldKey.startsWith(`${pass.id}:`)) {
        this.bytes -= oldEntry.canvas.width * oldEntry.canvas.height * 4;
        oldEntry.canvas.width = 0; oldEntry.canvas.height = 0;
        this.entries.delete(oldKey);
      }
    }
    const effects = draw(target);
    this.entries.set(entryKey, { canvas: bitmap, effects });
    this.bytes += required;
    this.blit(ctx, bitmap);
    return true;
  }

  private blit(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
  }
}
