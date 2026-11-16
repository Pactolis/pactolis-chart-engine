/** Owns selection policy, reverse-index hit testing, per-chart hit context and selection handles. Depends on the state owner and notification boundary; it does not depend on gesture editing. State and facade call these hooks on the same instance. */
import type { View } from "../../core/engine/view.js";
import { uiColor, axisMajorLabelColor, drawingAnchorPrimaryFill, drawingAnchorOutline } from "../../core/ui/seriesPalette.js";
import type { Drawing, DrawingContext, DrawingPoint } from "../../core/drawingTypes.js";
import { hasThreeAnchors, isSinglePointTool, isTextEditableTool, lastOf, screenPoint } from "./drawingPrimitives.js";
import { DRAWING_HANDLE_RADIUS_PX, TOUCH_DRAWING_HANDLE_RADIUS_PX, drawingHitTest, type DrawingHitContext } from "./drawingHitTest.js";
import { DrawingState } from "./drawingState.js";

export class DrawingSelection extends DrawingState {

  get selected(): Drawing | null {
    return structuredClone(this.drawings.find((drawing) => drawing.id === this.selectedId) ?? null);
  }

  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  getSelectedDrawings(): Drawing[] {
    return structuredClone(this.drawings.filter((drawing) => this.selectedIds.has(drawing.id)));
  }

  select(id: string, additive = false): Drawing | null {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return null;
    if (additive) this.toggleSelection(id);
    else this.setSelection([id], id);
    return structuredClone(drawing);
  }

  selectMany(ids: string[]): void {
    const valid = ids.filter((id) => this.drawings.some((drawing) => drawing.id === id));
    this.setSelection(valid, lastOf(valid) ?? null);
  }

  clearSelection(): void {
    if (!this.selectedId && this.selectedIds.size === 0) return;
    this.selectedId = null;
    this.selectedIds.clear();
    this.changed();
  }

  requestText(id: string): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing || !isTextEditableTool(drawing.type)) return;
    this.setSelection([id], id);
    this.onRequestText?.(id, false);
  }

  requestSettings(id: string): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing || isTextEditableTool(drawing.type)) return;
    // Always notify: the hit test before a double-click may already have selected it silently.
    this.setSelection([id], id, true);
    this.onRequestSettings?.(id);
  }

  setHitTestContext(view: View, time: DrawingContext): void {
    this.lastView = view;
    this.lastTime = time;
  }

  /** Drops the view and time mapping `view`'s chart supplied, so a disposed chart is not kept reachable here; other charts' stay. */
  releaseHitTestContext(view: View): void { if (this.lastView === view) { this.lastView = null; this.lastTime = null; } }

  hitTestAt(point: DrawingPoint, screen?: { x: number; y: number }): Drawing | null {
    const selectable = this.drawingAt(point, screen, this.touchTargets);
    if (!selectable) return null;
    if (!this.selectedIds.has(selectable.id)) this.setSelection([selectable.id], selectable.id, false);
    else this.selectedId = selectable.id;
    return structuredClone(selectable);
  }

  /** The drawing under the pointer and whether it is already selected; unlike hitTestAt it selects nothing. */
  peekAt(point: DrawingPoint, screen?: { x: number; y: number }, options: { touch?: boolean } = {}): { id: string; selected: boolean } | null {
    const found = this.drawingAt(point, screen, options.touch === true);
    return found ? { id: found.id, selected: this.selectedIds.has(found.id) } : null;
  }

  protected drawingAt(point: DrawingPoint, screen: { x: number; y: number } | undefined, touch: boolean): Drawing | undefined {
    const context = this.hitContext(touch);
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const drawing = this.drawings[i];
      if (
        drawing.visible &&
        drawing.market === this.currentMarket &&
        drawingHitTest(drawing, point, screen, context)
      ) {
        return drawing;
      }
    }
    return undefined;
  }

  protected hitContext(touch: boolean): DrawingHitContext {
    return { view: this.lastView, time: this.lastTime, positionRisk: this.positionRiskSettings, touch };
  }

  /** Render selection anchors on the interaction surface, separate from annotation drawings. */
  renderSelection(
    ctx: CanvasRenderingContext2D,
    view: View,
    time: DrawingContext,
    market?: string
  ): void {
    const renderMarket = market ?? this.currentMarket;
    ctx.save();
    for (const drawing of this.drawings) {
      if (!this.selectedIds.has(drawing.id) || !drawing.visible || drawing.points.length < 2) continue;
      if (drawing.market !== renderMarket) continue;
      const a = screenPoint(drawing.points[0], view, time);
      const b = screenPoint(drawing.points[1], view, time);
      this.drawSelection(ctx, drawing, a, b, drawing.id === this.selectedId, view, time);
    }
    ctx.restore();
  }

  protected setSelection(ids: string[], primary: string | null | undefined = undefined, emit = false): void {
    const valid = ids.filter((id) => this.drawings.some((drawing) => drawing.id === id));
    this.selectedIds = new Set(valid);
    this.selectedId = primary && this.selectedIds.has(primary) ? primary : (lastOf(valid) ?? null);
    this.summaryRevision++;
    if (emit) this.changed();
  }

  protected toggleSelection(id: string): void {
    if (!this.drawings.some((drawing) => drawing.id === id)) return;
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      this.selectedId = this.selectedId === id ? (lastOf([...this.selectedIds]) ?? null) : this.selectedId;
    } else {
      this.selectedIds.add(id);
      this.selectedId = id;
    }
    this.summaryRevision++;
  }

  protected pruneSelection(): void {
    const validIds = new Set(this.drawings.map((drawing) => drawing.id));
    this.selectedIds = new Set([...this.selectedIds].filter((id) => validIds.has(id)));
    this.selectedId = this.selectedId && this.selectedIds.has(this.selectedId) ? this.selectedId : (lastOf([...this.selectedIds]) ?? null);
  }

  protected selectedInDrawOrder(): Drawing[] {
    return this.drawings.filter((drawing) => this.selectedIds.has(drawing.id));
  }

  protected selectionKey(): string { return `${this.selectedId ?? ""}|${[...this.selectedIds].join(",")}`; }

  protected drawSelection(
    ctx: CanvasRenderingContext2D,
    drawing: Drawing,
    a: { x: number; y: number },
    b: { x: number; y: number },
    primary = false,
    view: View = this.lastView!,
    time: DrawingContext = this.lastTime!
  ): void {
    ctx.save();
    ctx.fillStyle = primary ? drawingAnchorPrimaryFill : uiColor.buy;
    ctx.strokeStyle = drawingAnchorOutline;
    const anchors = isSinglePointTool(drawing.type)
      ? [a]
      : hasThreeAnchors(drawing.type) && drawing.points[2]
        ? [a, b, screenPoint(drawing.points[2], view, time)]
        : [a, b];
    const radius = this.touchTargets ? TOUCH_DRAWING_HANDLE_RADIUS_PX : DRAWING_HANDLE_RADIUS_PX;
    for (const point of anchors) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (drawing.locked) {
      ctx.fillStyle = axisMajorLabelColor;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText("🔒", a.x + 7, a.y - 7);
    }
    ctx.restore();
  }
}
