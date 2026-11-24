/** Owns draft placement and pointer editing, including one-history-step gesture commits. Depends on selection/hit testing and the shared state/notification base; no dependency points back to DrawingManager. The facade delegates through inheritance to preserve method and field identity without a second mutable graph. */
import { getDrawingTool } from "./toolRegistry.js";
import type { DrawingPoint, DrawingType } from "../../core/drawingTypes.js";
import { applyStylePreset, constrainDraftPoint, constrainPointEdit, defaultFibonacciExtensionPoint, defaultParallelChannelPoint, defaultPitchforkPoint, isPositionTool, isSinglePointTool, isTextEditableTool, isThreePointTool, lastOf, normalizeDrawingPointsInPlace, normalizeDrawingStyleInPlace, pointDistance, simplifyBrushPoints } from "./drawingPrimitives.js";
import { positionLevelHitIndex } from "./drawingHitTest.js";
import { DrawingSelection } from "./drawingSelection.js";

export class DrawingGestures extends DrawingSelection {

  setTool(tool: DrawingType | null): void {
    if (this.draft && tool !== this.tool) this.cancelDraft();
    if (tool === null) this.cancelDraft();
    this.tool = tool;
    this.onToolChange?.(this.tool);
  }

  hasDraft(): boolean { return this.draft !== null; }

  getPlacementStatus(): { state: "placing"; remainingAnchors: number; requiredAnchors: number } | null {
    if (!this.draft || this.draft.type === "brush") return null;
    const requiredAnchors = getDrawingTool(this.draft.type).pointsRequired;
    if (requiredAnchors <= 1) return null;
    const lockedAnchors = this.draftStage === 2 ? 2 : 1;
    return {
      state: "placing",
      remainingAnchors: Math.max(1, requiredAnchors - lockedAnchors),
      requiredAnchors,
    };
  }

  isPointerDragActive(): boolean {
    return this.draggingSelection !== null || this.editingPoint !== null || this.draft?.type === "brush";
  }

  cancelDraft(): void {
    if (!this.draft) return;
    const draftId = this.draft.id;
    this.drawings = this.drawings.filter((drawing) => drawing.id !== draftId);
    this.displayNameCache = null;
    this.draft = null;
    this.draftStage = null;
    this.placementPointerDown = false;
    this.placementMoved = false;
    this.placementCommitted = false;
    this.draggingSelection = null;
    this.editingPoint = null;
    this.editingDrawing = null;
    this.selectedIds.delete(draftId);
    if (this.selectedId === draftId) this.selectedId = lastOf([...this.selectedIds]) ?? null;
    this.onToolChange?.(this.tool);
  }

  get activeTool(): DrawingType | null {
    return this.tool;
  }

  pointerDown(point: DrawingPoint, screen?: { x: number; y: number }, options: { additive?: boolean; touch?: boolean } = {}): boolean {
    this.placementCommitted = false;
    this.touchTargets = options.touch === true;
    if (this.draft && this.draft.type !== "brush") {
      const tool = getDrawingTool(this.draft.type);
      if (tool.pointsRequired === 3 && this.draftStage === 1) {
        this.draft.points[1] = constrainDraftPoint(this.draft, point, 1);
        if (this.draft.type === "parallel-channel" || this.draft.type === "regression-channel") this.draft.points[2] = defaultParallelChannelPoint(this.draft.points[0], this.draft.points[1]);
        if (this.draft.type === "pitchfork") this.draft.points[2] = defaultPitchforkPoint(this.draft.points[0], this.draft.points[1]);
        if (this.draft.type === "fibonacci-extension") this.draft.points[2] = defaultFibonacciExtensionPoint(this.draft.points[0], this.draft.points[1]);
        normalizeDrawingPointsInPlace(this.draft, 1);
        this.draftStage = 2;
        this.onToolChange?.(this.tool);
        return true;
      }
      if (tool.pointsRequired === 3 && this.draftStage === 2) {
        this.draft.points[2] = constrainDraftPoint(this.draft, point, 2);
        normalizeDrawingPointsInPlace(this.draft, 2);
        this.commitDraft();
        return true;
      }
      if (tool.pointsRequired === 2 && this.draftStage === 1) {
        this.draft.points[1] = constrainDraftPoint(this.draft, point, 1);
        normalizeDrawingPointsInPlace(this.draft, 1);
        this.commitDraft();
        return true;
      }
    }
    if (!this.tool) {
      const selectable = this.drawingAt(point, screen, this.touchTargets);
      if (!selectable) {
        if (!options.additive && (this.selectedId !== null || this.selectedIds.size > 0)) {
          this.selectedId = null;
          this.selectedIds.clear();
          this.changed();
        }
        return false;
      }
      if (options.additive) {
        this.toggleSelection(selectable.id);
        this.changed();
        return true;
      }
      const selectionBefore = this.selectionKey();
      if (!this.selectedIds.has(selectable.id) || this.selectedIds.size <= 1) {
        this.setSelection([selectable.id], selectable.id, false);
      } else {
        this.selectedId = selectable.id;
      }
      // A locked drawing gets no drag, so no pointerUp change follows: report the selection now.
      if (selectable.locked) { if (this.selectionKey() !== selectionBefore) this.changed(); return true; }
      this.gestureBefore = structuredClone(this.drawings);
      if (this.selectedIds.size > 1 && this.selectedIds.has(selectable.id)) {
        this.draggingSelection = {
          start: { ...point },
          before: this.selectedInDrawOrder()
            .filter((drawing) => !drawing.locked)
            .map((drawing) => ({ drawing, id: drawing.id, points: drawing.points.map((item) => ({ ...item })) })),
        };
        return true;
      }
      if (isPositionTool(selectable.type)) {
        const levelIndex = positionLevelHitIndex(selectable, point, screen, this.hitContext(this.touchTargets));
        if (levelIndex !== null) {
          this.editingPoint = levelIndex;
          this.editingDrawing = selectable;
          return true;
        }
        this.draggingSelection = {
          start: { ...point },
          before: [{ drawing: selectable, id: selectable.id, points: selectable.points.map((item) => ({ ...item })) }],
        };
        return true;
      }
      this.editingPoint = selectable.points.reduce(
        (best, item, index) =>
          pointDistance(item, point) < pointDistance(selectable.points[best], point)
            ? index : best,
        0
      );
      this.editingDrawing = selectable;
      return true;
    }
    const tool = getDrawingTool(this.tool);
    const draftPoints = (tool.pointsRequired === 1 || this.tool === "brush") ? [point, point] : [point];
    this.draft = {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      type: this.tool,
      points: draftPoints,
      color: tool.color,
      lineWidth: tool.lineWidth,
      lineStyle: tool.lineStyle ?? "solid",
      showLabel: tool.showLabel ?? true,
      showPriceLabel: tool.showPriceLabel ?? false,
      showTimeLabel: tool.showTimeLabel ?? false,
      fillOpacity: tool.fillOpacity,
      text: isTextEditableTool(this.tool) ? "" : undefined,
      locked: false,
      visible: true,
      market: this.currentMarket,
      opacity: tool.opacity,
      valueAreaPercent: 0.7,
      showPoc: true,
      showVah: true,
      showVal: true,
      profileWidth: 0.3,
      dataState: "placing",
      extendLeft: tool.extendLeft,
      extendRight: tool.extendRight,
    };
    applyStylePreset(this.draft, this.drawingTemplates.defaults[this.tool] ?? {});
    normalizeDrawingStyleInPlace(this.draft);
    this.draftStage = 1;
    this.placementPointerDown = true;
    this.placementMoved = false;
    this.drawings.push(this.draft);
    this.displayNameCache = null;
    this.summaryRevision++;
    if (tool.pointsRequired > 1 && this.tool !== "brush") this.onToolChange?.(this.tool);
    if (tool.pointsRequired === 1) this.commitDraft();
    return true;
  }

  pointerMove(point: DrawingPoint): boolean {
    if (this.draggingSelection) {
      const deltaTime = point.time - this.draggingSelection.start.time;
      const deltaPrice = point.price - this.draggingSelection.start.price;
      for (const item of this.draggingSelection.before) {
        const drawing = item.drawing;
        if (!drawing || drawing.locked) continue;
        drawing.points = item.points.map((original) => ({ time: original.time + deltaTime, price: original.price + deltaPrice }));
      }
      return true;
    }
    if (this.editingPoint !== null && this.selectedId) {
      const drawing = this.editingDrawing;
      if (!drawing || drawing.locked) return false;
      const nextPoint = constrainPointEdit(drawing, this.editingPoint, point);
      drawing.points[this.editingPoint] = nextPoint;
      normalizeDrawingPointsInPlace(drawing, this.editingPoint);
      return true;
    }
    if (!this.draft) return false;
    if (this.placementPointerDown) this.placementMoved = true;
    if (this.draft.type === "brush") {
      this.draft.points.push(point);
      return true;
    }
    if (isSinglePointTool(this.draft.type)) {
      this.draft.points[0] = point;
      this.draft.points[1] = point;
    } else if (isThreePointTool(this.draft.type) && this.draftStage === 2) {
      this.draft.points[2] = constrainDraftPoint(this.draft, point, 2);
      normalizeDrawingPointsInPlace(this.draft, 2);
    } else {
      this.draft.points[1] = constrainDraftPoint(this.draft, point, 1);
      if (this.draft.type === "parallel-channel" || this.draft.type === "regression-channel") this.draft.points[2] = defaultParallelChannelPoint(this.draft.points[0], this.draft.points[1]);
      if (this.draft.type === "pitchfork") this.draft.points[2] = defaultPitchforkPoint(this.draft.points[0], this.draft.points[1]);
      if (this.draft.type === "fibonacci-extension") this.draft.points[2] = defaultFibonacciExtensionPoint(this.draft.points[0], this.draft.points[1]);
      if (isThreePointTool(this.draft.type)) normalizeDrawingPointsInPlace(this.draft, 1);
    }
    return true;
  }

  pointerUp(): boolean {
    if (this.placementCommitted) {
      this.placementCommitted = false;
      return true;
    }
    if (this.draggingSelection || this.editingPoint !== null) {
      this.draggingSelection = null;
      this.editingPoint = null;
      this.editingDrawing = null;
      this.commitGesture();
      this.changed();
      return true;
    }
    if (!this.draft) return false;
    if (this.draft.type !== "brush") {
      const wasPressed = this.placementPointerDown;
      const moved = this.placementMoved;
      this.placementPointerDown = false;
      this.placementMoved = false;
      if (wasPressed && moved && this.draftStage === 1 && getDrawingTool(this.draft.type).pointsRequired === 3) {
        this.draftStage = 2;
        this.onToolChange?.(this.tool);
      } else if (wasPressed && moved && this.draftStage === 1) {
        this.commitDraft();
      }
      return true;
    }
    this.draft.points = simplifyBrushPoints(this.draft.points);
    this.commitDraft();
    return true;
  }

  protected commitDraft(): void {
    if (!this.draft) return;
    const requiredAnchors = getDrawingTool(this.draft.type).pointsRequired;
    if (this.draft.points.length < requiredAnchors) return;
    const completedId = this.draft.id;
    const completedType = this.draft.type;
    const completedDraft = this.draft;
    completedDraft.dataState = "ready";
    this.drawings = this.drawings.filter((drawing) => drawing.id !== completedId);
    this.snapshot();
    this.drawings.push(completedDraft);
    normalizeDrawingPointsInPlace(completedDraft, isThreePointTool(completedType) ? 2 : 1);
    this.setSelection([completedId], completedId, false);
    this.draft = null;
    this.draftStage = null;
    this.placementPointerDown = false;
    this.placementMoved = false;
    this.placementCommitted = true;
    this.tool = null;
    this.onToolChange?.(this.tool);
    this.changed();
    if (isTextEditableTool(completedType)) this.onRequestText?.(completedId, true);
  }

  /** A drag is one undo step; a click that only selects adds none and keeps the redo stack. */
  protected commitGesture(): void {
    if (this.gestureBefore && JSON.stringify(this.gestureBefore) !== JSON.stringify(this.drawings)) this.pushHistory(this.gestureBefore);
    this.gestureBefore = null;
  }
}
