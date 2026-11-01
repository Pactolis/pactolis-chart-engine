import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { drawAnalysisDrawings } from "../../core/render/analysisDrawings.js";
import { t } from "../../core/chartLocale.js";
import { getDrawingTool } from "./toolRegistry.js";
import { uiColor, axisMajorLabelColor, drawingAnchorPrimaryFill, drawingAnchorOutline } from "../../core/ui/seriesPalette.js";
import type {
  Drawing,
  DrawingContext,
  DrawingNamedPreset,
  DrawingPoint,
  DrawingStylePreset,
  DrawingTemplateState,
  DrawingType,
  PositionRiskSettings,
} from "../../core/drawingTypes.js";

export type {
  Drawing,
  DrawingContext,
  DrawingDataState,
  DrawingNamedPreset,
  DrawingPoint,
  DrawingStylePreset,
  DrawingTemplateState,
  DrawingType,
  FibonacciLabelFormat,
  FibonacciLabelSide,
  FibonacciLevel,
  PositionOrderKind,
  PositionRiskSettings,
} from "../../core/drawingTypes.js";

import {
  DEFAULT_DRAWING_TEMPLATE_STATE,
  DEFAULT_POSITION_RISK_SETTINGS,
  applyLineStyle,
  applyStylePreset,
  clamp01,
  constrainDraftPoint,
  constrainPointEdit,
  defaultFibonacciExtensionPoint,
  defaultParallelChannelPoint,
  defaultPitchforkPoint,
  drawLine,
  drawObjectName,
  drawingDisplayName,
  drawingStylePresetFromDrawing,
  duplicateDrawing,
  hasThreeAnchors,
  isAnnotationTool,
  isFibonacciTool,
  isMeasurementTool,
  isPositionTool,
  isSinglePointTool,
  isTextEditableTool,
  isThreePointTool,
  isZoneTool,
  lastOf,
  normalizeDrawing,
  normalizeDrawingPointsInPlace,
  normalizeDrawingStyleInPlace,
  normalizeDrawingTemplateState,
  normalizePositionRiskSettings,
  pointDistance,
  queuePriceAxisLabel,
  queueTimeAxisLabel,
  queueTrendPriceLabels,
  queueZonePriceLabels,
  queueZoneTimeLabels,
  safeDrawingTypeLabel,
  renderAnnotationTool,
  renderBrush,
  renderEllipse,
  renderFibonacciTool,
  renderGannFan,
  renderGannGrid,
  renderMeasurementTool,
  renderParallelChannel,
  renderPitchfork,
  renderRegressionChannel,
  renderTriangle,
  screenPoint,
  simplifyBrushPoints,
  summarizeMarketDrawings,
  type DrawingMarketSummary,
  trendRenderLine,
  zoneRenderBox,
} from "./drawingPrimitives.js";
import {
  DRAWING_HANDLE_RADIUS_PX,
  TOUCH_DRAWING_HANDLE_RADIUS_PX,
  drawingHitTest,
  positionLevelHitIndex,
  type DrawingHitContext,
} from "./drawingHitTest.js";

export {
  DEFAULT_DRAWING_TEMPLATE_STATE,
  DEFAULT_FIBONACCI_EXTENSION_LEVELS,
  DEFAULT_FIBONACCI_RETRACEMENT_LEVELS,
  DEFAULT_POSITION_RISK_SETTINGS,
  LEGACY_DRAWING_MARKET,
  normalizePositionRiskSettings,
  positionRiskMetrics,
} from "./drawingPrimitives.js";

export class DrawingManager {
  private drawings: Drawing[] = [];
  private undoStack: Drawing[][] = [];
  private redoStack: Drawing[][] = [];
  private tool: DrawingType | null = null;
  private draft: Drawing | null = null;
  private draftStage: 1 | 2 | null = null;
  private placementPointerDown = false;
  private placementMoved = false;
  private placementCommitted = false;
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  private editingPoint: number | null = null;
  private draggingSelection: { start: DrawingPoint; before: Array<{ id: string; points: DrawingPoint[] }> } | null = null;
  private gestureBefore: Drawing[] | null = null; // drawings before a pointer drag/point edit, see commitGesture
  private clipboard: Drawing[] = [];
  private positionRiskSettings: PositionRiskSettings = structuredClone(DEFAULT_POSITION_RISK_SETTINGS);
  private drawingTemplates: DrawingTemplateState = structuredClone(DEFAULT_DRAWING_TEMPLATE_STATE);
  private styleClipboard: DrawingStylePreset | null = null;
  private currentMarket = "";
  private lastView: View | null = null;
  private lastTime: DrawingContext | null = null;
  /** The last press came from a finger: hit tests pick wider and selected drawings draw bigger handles. */
  private touchTargets = false;
  private summaryRevision = 0;
  private readonly summaryCache = new Map<string, { revision: number; summary: DrawingMarketSummary }>();
  private readonly readonlyListCache = new Map<string, { revision: number; draftId: string | null; list: readonly Drawing[] }>();
  private displayNameCache: Map<string, string> | null = null;

  private getDisplayNames(): Map<string, string> {
    if (this.displayNameCache) return this.displayNameCache;
    const cache = new Map<string, string>();
    const typeCounters = new Map<DrawingType, number>();
    for (const drawing of this.drawings) {
      const count = (typeCounters.get(drawing.type) ?? 0) + 1;
      typeCounters.set(drawing.type, count);
      if (drawing.text && drawing.text.trim()) {
        cache.set(drawing.id, drawing.text);
      } else if (drawing.type === "text") {
        cache.set(drawing.id, t("draw.text"));
      } else {
        const base = safeDrawingTypeLabel(drawing.type);
        cache.set(drawing.id, `${base} ${count}`);
      }
    }
    this.displayNameCache = cache;
    return cache;
  }

  constructor(
    private readonly onChange: (drawings: Drawing[], transient: boolean) => void,
    private readonly onToolChange?: (tool: DrawingType | null) => void,
    private readonly onRequestText?: (id: string, deleteOnCancel?: boolean) => void,
    private readonly onRequestSettings?: (id: string) => void,
  ) {}

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
    this.selectedIds.delete(draftId);
    if (this.selectedId === draftId) this.selectedId = lastOf([...this.selectedIds]) ?? null;
    this.onToolChange?.(this.tool);
  }

  setMarket(market: string): void {
    if (market === this.currentMarket) return;
    this.currentMarket = market;
    this.changed();
  }

  getMarket(): string {
    return this.currentMarket;
  }

  get selected(): Drawing | null {
    return structuredClone(this.drawings.find((drawing) => drawing.id === this.selectedId) ?? null);
  }

  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  getSelectedDrawings(): Drawing[] {
    return structuredClone(this.drawings.filter((drawing) => this.selectedIds.has(drawing.id)));
  }

  get activeTool(): DrawingType | null {
    return this.tool;
  }

  getPositionRiskSettings(): PositionRiskSettings {
    return structuredClone(this.positionRiskSettings);
  }

  setPositionRiskSettings(settings: Partial<PositionRiskSettings>, notify = true): void {
    this.positionRiskSettings = normalizePositionRiskSettings({ ...this.positionRiskSettings, ...settings });
    if (notify) this.changed();
  }

  getDrawingTemplateState(): DrawingTemplateState {
    return structuredClone(this.drawingTemplates);
  }

  setDrawingTemplateState(state: Partial<DrawingTemplateState> | undefined, notify = true): void {
    this.drawingTemplates = normalizeDrawingTemplateState(state);
    if (notify) this.changed();
  }

  exportDrawingTemplates(): string {
    return JSON.stringify(this.drawingTemplates, null, 2);
  }

  importDrawingTemplates(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Partial<DrawingTemplateState>;
      this.setDrawingTemplateState(parsed);
      return true;
    } catch {
      return false;
    }
  }

  saveSelectedAsDefault(): void {
    const drawing = this.drawings.find((item) => item.id === this.selectedId);
    if (!drawing) return;
    this.drawingTemplates.defaults[drawing.type] = drawingStylePresetFromDrawing(drawing);
    this.changed();
  }

  resetDefaultForSelectedTool(): void {
    const type = this.selected?.type;
    if (!type || !this.drawingTemplates.defaults[type]) return;
    delete this.drawingTemplates.defaults[type];
    this.changed();
  }

  applyDefaultToSelected(): void {
    const drawing = this.drawings.find((item) => item.id === this.selectedId);
    if (!drawing) return;
    const preset = this.drawingTemplates.defaults[drawing.type];
    if (!preset) return;
    this.snapshot();
    applyStylePreset(drawing, preset);
    normalizeDrawingStyleInPlace(drawing);
    normalizeDrawingPointsInPlace(drawing, 0);
    this.changed();
  }

  copySelectedStyle(): void {
    const drawing = this.drawings.find((item) => item.id === this.selectedId);
    if (!drawing) return;
    this.styleClipboard = drawingStylePresetFromDrawing(drawing);
  }

  pasteStyleToSelected(): void {
    if (!this.styleClipboard) return;
    const selected = this.selectedInDrawOrder().filter((drawing) => !drawing.locked);
    if (!selected.length) return;
    this.snapshot();
    for (const drawing of selected) {
      applyStylePreset(drawing, this.styleClipboard);
      normalizeDrawingStyleInPlace(drawing);
      normalizeDrawingPointsInPlace(drawing, 0);
    }
    this.changed();
  }

  saveSelectedPreset(name: string): void {
    const drawing = this.drawings.find((item) => item.id === this.selectedId);
    const cleanName = name.trim();
    if (!drawing || !cleanName) return;
    const preset: DrawingNamedPreset = {
      id: crypto.randomUUID(),
      name: cleanName,
      type: drawing.type,
      style: drawingStylePresetFromDrawing(drawing),
      createdAt: Date.now(),
    };
    this.drawingTemplates.presets = [preset, ...this.drawingTemplates.presets].slice(0, 50);
    this.changed();
  }

  applyPresetToSelected(presetId: string): void {
    const drawing = this.drawings.find((item) => item.id === this.selectedId);
    if (!drawing) return;
    const preset = this.drawingTemplates.presets.find((item) => item.id === presetId && item.type === drawing.type);
    if (!preset) return;
    this.snapshot();
    applyStylePreset(drawing, preset.style);
    normalizeDrawingStyleInPlace(drawing);
    normalizeDrawingPointsInPlace(drawing, 0);
    this.changed();
  }

  deletePreset(presetId: string): void {
    const before = this.drawingTemplates.presets.length;
    this.drawingTemplates.presets = this.drawingTemplates.presets.filter((preset) => preset.id !== presetId);
    if (this.drawingTemplates.presets.length !== before) this.changed();
  }

  replace(drawings: Drawing[]): void {
    this.displayNameCache = null;
    this.drawings = structuredClone(drawings).map(normalizeDrawing);
    this.pruneSelection();
    this.gestureBefore = null;
    this.undoStack = [];
    this.redoStack = [];
    this.summaryRevision++;
  }

  list(): Drawing[] {
    return structuredClone(this.drawings);
  }

  listCurrent(): Drawing[] {
    return this.listForMarket(this.currentMarket);
  }

  listCurrentReadonly(): readonly Drawing[] {
    return this.listForMarketReadonly(this.currentMarket);
  }

  listForMarket(market: string): Drawing[] {
    return structuredClone(this.drawings.filter((drawing) => drawing.id !== this.draft?.id && drawing.market === market));
  }

  listForMarketReadonly(market: string): readonly Drawing[] {
    const draftId = this.draft?.id ?? null;
    const cached = this.readonlyListCache.get(market);
    if (cached && cached.revision === this.summaryRevision && cached.draftId === draftId) {
      return cached.list;
    }
    const list = this.drawings.filter((drawing) => drawing.id !== draftId && drawing.market === market);
    this.readonlyListCache.set(market, { revision: this.summaryRevision, draftId, list });
    return list;
  }

  /** Read-only test-hook seam: summarizes one market's drawings without cloning them. */
  marketSummary(market: string): DrawingMarketSummary {
    const cached = this.summaryCache.get(market);
    if (cached && cached.revision === this.summaryRevision) {
      return cached.summary;
    }
    const summary = summarizeMarketDrawings(this.drawings, market, this.selectedId, this.selectedIds, this.draft?.id ?? null);
    this.summaryCache.set(market, { revision: this.summaryRevision, summary });
    return summary;
  }

  /** Read-only render seam: avoids cloning the full drawing graph on every frame. */
  renderAnalysis(
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    time: DrawingContext,
    onLineObject?: (price: number, text: string, color: string) => void,
    market?: string,
  ): void {
    drawAnalysisDrawings(
      ctx,
      view,
      series,
      time,
      this.drawings,
      market ?? this.currentMarket,
      onLineObject,
    );
  }

  update(id: string, patch: Partial<Drawing>, notify = true): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return;
    Object.assign(drawing, structuredClone(patch));
    normalizeDrawingStyleInPlace(drawing);
    normalizeDrawingPointsInPlace(drawing, 0);
    if (notify) this.changed();
  }

  /** Transient single-drawing preview (redraws, not persisted); pair with `commitUpdateFromSnapshot`. */
  preview(id: string, patch: Partial<Drawing>): void { this.update(id, patch, false); this.changed(true); }
  updateWithHistory(id: string, patch: Partial<Drawing>): void {
    const previous = structuredClone(this.drawings);
    this.update(id, patch, false);
    if (JSON.stringify(previous) !== JSON.stringify(this.drawings)) { this.pushHistory(previous); this.changed(); }
  }

  commitUpdateFromSnapshot(id: string, before: Drawing): void {
    const current = this.drawings.find((item) => item.id === id);
    if (!current) return;
    const normalizedBefore = normalizeDrawing(before);
    if (JSON.stringify(normalizeDrawing(current)) === JSON.stringify(normalizedBefore)) return;
    const previous = this.drawings.map((drawing) =>
      drawing.id === id ? structuredClone(normalizedBefore) : structuredClone(drawing)
    );
    this.pushHistory(previous);
    this.changed();
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

  duplicateSelected(): void {
    const selected = this.selectedInDrawOrder().filter((drawing) => !drawing.locked);
    if (!selected.length) return;
    this.snapshot();
    const copies: Drawing[] = [];
    for (const drawing of selected) {
      const copy = duplicateDrawing(drawing, [...this.drawings, ...copies], this.currentMarket);
      copies.push(copy);
    }
    this.drawings.push(...copies);
    this.setSelection(copies.map((drawing) => drawing.id), lastOf(copies)?.id ?? null, false);
    this.changed();
  }

  copySelected(): void {
    const selected = this.selectedInDrawOrder();
    if (!selected.length) return;
    this.clipboard = structuredClone(selected);
  }

  pasteClipboard(): void {
    this.pasteClipboardForMarket(this.currentMarket);
  }

  pasteClipboardForMarket(market: string): void {
    if (!this.clipboard.length) return;
    this.snapshot();
    const copies: Drawing[] = [];
    for (const drawing of this.clipboard) {
      const copy = duplicateDrawing(drawing, [...this.drawings, ...copies], market);
      copies.push(copy);
    }
    this.drawings.push(...copies);
    this.setSelection(copies.map((drawing) => drawing.id), lastOf(copies)?.id ?? null, false);
    this.changed();
  }

  duplicateToMarket(id: string, market: string): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return;
    this.snapshot();
    const copy = duplicateDrawing(drawing, this.drawings, market);
    this.drawings.push(copy);
    this.setSelection([copy.id], copy.id, false);
    this.changed();
  }

  bringSelectedForward(): void {
    this.moveSelectedZ(1);
  }

  sendSelectedBackward(): void {
    this.moveSelectedZ(-1);
  }

  private moveSelectedZ(delta: 1 | -1): void {
    if (!this.selectedIds.size) return;
    let moved = false;
    const next = [...this.drawings];
    if (delta > 0) {
      for (let index = next.length - 2; index >= 0; index--) {
        if (this.selectedIds.has(next[index].id) && !this.selectedIds.has(next[index + 1].id)) {
          [next[index], next[index + 1]] = [next[index + 1], next[index]];
          moved = true;
        }
      }
    } else {
      for (let index = 1; index < next.length; index++) {
        if (this.selectedIds.has(next[index].id) && !this.selectedIds.has(next[index - 1].id)) {
          [next[index], next[index - 1]] = [next[index - 1], next[index]];
          moved = true;
        }
      }
    }
    if (!moved) return;
    this.snapshot();
    this.drawings = next;
    this.pruneSelection();
    this.changed();
  }

  setSelectedVisible(visible: boolean): void {
    this.updateSelectedBatch((drawing) => { drawing.visible = visible; });
  }

  setSelectedLocked(locked: boolean): void {
    this.updateSelectedBatch((drawing) => { drawing.locked = locked; });
  }

  /** Applies one style patch to every selected drawing as a single undo step. */
  updateSelectedWithHistory(patch: Partial<Drawing>): void { this.updateSelectedBatch((drawing) => { Object.assign(drawing, structuredClone(patch)); }); }

  /** Transient live preview (not persisted); pair with `commitPreview` for one undo step and one save. */
  previewSelected(patch: Partial<Drawing>): void {
    const selected = this.selectedInDrawOrder();
    if (!selected.length) return;
    for (const drawing of selected) {
      Object.assign(drawing, structuredClone(patch));
      normalizeDrawingStyleInPlace(drawing);
      normalizeDrawingPointsInPlace(drawing, 0);
    }
    this.changed(true);
  }

  /** Records `previous` (a `list()` taken before the preview began) as the undo step for it. */
  commitPreview(previous: Drawing[]): void {
    if (JSON.stringify(previous) === JSON.stringify(this.drawings)) return;
    this.pushHistory(structuredClone(previous));
    this.changed();
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

  private drawingAt(point: DrawingPoint, screen: { x: number; y: number } | undefined, touch: boolean): Drawing | undefined {
    const context = this.hitContext(touch);
    return [...this.drawings].reverse().find((drawing) =>
      drawing.visible &&
      drawing.market === this.currentMarket &&
      drawingHitTest(drawing, point, screen, context)
    );
  }

  private hitContext(touch: boolean): DrawingHitContext {
    return { view: this.lastView, time: this.lastTime, positionRisk: this.positionRiskSettings, touch };
  }

  setVisible(id: string, visible: boolean): void { this.updateWithHistory(id, { visible }); }
  setLocked(id: string, locked: boolean): void { this.updateWithHistory(id, { locked }); }
  setVisibleMany(ids: string[], visible: boolean): void { this.setVisibleWhere((drawing) => ids.includes(drawing.id), visible); }

  setAllVisible(visible: boolean): void { this.setAllVisibleForMarket(this.currentMarket, visible); }

  setAllVisibleForMarket(market: string, visible: boolean): void { this.setVisibleWhere((drawing) => drawing.market === market, visible); }

  private setVisibleWhere(match: (drawing: Drawing) => boolean, visible: boolean): void {
    const scoped = this.drawings.filter(match);
    if (!scoped.some((drawing) => drawing.visible !== visible)) return;
    this.snapshot();
    for (const drawing of scoped) drawing.visible = visible;
    this.changed();
  }

  delete(id: string): void {
    this.setSelection([id], id, false);
    this.deleteSelected();
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
            .map((drawing) => ({ id: drawing.id, points: drawing.points.map((item) => ({ ...item })) })),
        };
        return true;
      }
      if (isPositionTool(selectable.type)) {
        const levelIndex = positionLevelHitIndex(selectable, point, screen, this.hitContext(this.touchTargets));
        if (levelIndex !== null) {
          this.editingPoint = levelIndex;
          return true;
        }
        this.draggingSelection = {
          start: { ...point },
          before: [{ id: selectable.id, points: selectable.points.map((item) => ({ ...item })) }],
        };
        return true;
      }
      this.editingPoint = selectable.points.reduce(
        (best, item, index) =>
          pointDistance(item, point) < pointDistance(selectable.points[best], point)
            ? index : best,
        0
      );
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
        const drawing = this.drawings.find((candidate) => candidate.id === item.id);
        if (!drawing || drawing.locked) continue;
        drawing.points = item.points.map((original) => ({ time: original.time + deltaTime, price: original.price + deltaPrice }));
      }
      return true;
    }
    if (this.editingPoint !== null && this.selectedId) {
      const drawing = this.drawings.find((item) => item.id === this.selectedId);
      if (!drawing) return false;
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

  private commitDraft(): void {
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

  deleteSelected(): void {
    const selected = this.selectedInDrawOrder().filter((drawing) => !drawing.locked);
    if (!selected.length) return;
    const deleted = new Set(selected.map((drawing) => drawing.id));
    this.snapshot();
    this.drawings = this.drawings.filter((drawing) => !deleted.has(drawing.id));
    this.selectedIds = new Set([...this.selectedIds].filter((id) => !deleted.has(id)));
    this.selectedId = this.selectedId && this.selectedIds.has(this.selectedId) ? this.selectedId : (lastOf([...this.selectedIds]) ?? null);
    this.changed();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(structuredClone(this.drawings));
    this.drawings = prev;
    this.pruneSelection();
    this.changed();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.drawings));
    this.drawings = next;
    this.changed();
  }

  render(
    ctx: CanvasRenderingContext2D,
    view: View,
    time: DrawingContext,
    onLineObject?: (price: number, text: string, color: string) => void,
    onTimeObject?: (time: number, text: string, color: string) => void,
    market?: string
  ): void {
    this.lastView = view;
    this.lastTime = time;
    const renderMarket = market ?? this.currentMarket;
    const displayNames = this.getDisplayNames();
    ctx.save();
    ctx.font = "12px ui-monospace, monospace";
    for (const drawing of this.drawings) {
      if (!drawing.visible || drawing.points.length < 2 || drawing.market !== renderMarket) continue;
      const a = screenPoint(drawing.points[0], view, time);
      const b = screenPoint(drawing.points[1], view, time);
      ctx.strokeStyle = drawing.color;
      ctx.fillStyle = drawing.color;
      ctx.lineWidth = drawing.lineWidth;
      applyLineStyle(ctx, drawing.lineStyle);
      const displayName = displayNames.get(drawing.id) ?? drawingDisplayName(drawing, this.drawings);
      ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
      if (drawing.type === "anchored-vwap" || drawing.type === "fixed-range-volume-profile") {
        ctx.fillStyle = drawing.color;
        ctx.beginPath();
        ctx.arc(a.x, a.y, this.selectedIds.has(drawing.id) ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
        if (drawing.type === "fixed-range-volume-profile") {
          ctx.beginPath();
          ctx.arc(b.x, b.y, this.selectedIds.has(drawing.id) ? 5 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (drawing.type === "horizontal") {
        drawLine(ctx, view.area.left, a.y, view.area.left + view.area.width, a.y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
      } else if (drawing.type === "horizontal-ray") {
        drawLine(ctx, Math.max(view.area.left, a.x), a.y, view.area.left + view.area.width, a.y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, Math.max(view.area.left, a.x), a.y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
      } else if (drawing.type === "vertical") {
        drawLine(ctx, a.x, view.area.top, a.x, view.area.top + view.area.height);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, a.x, view.area.top + 14);
        queueTimeAxisLabel(drawing, 0, displayName, onTimeObject);
      } else if (isAnnotationTool(drawing.type)) {
        renderAnnotationTool(ctx, drawing, a, b, view, displayName, onTimeObject);
      } else if (drawing.type === "trend" || drawing.type === "trend-ray" || drawing.type === "extended-trend") {
        const line = trendRenderLine(drawing, a, b, view);
        drawLine(ctx, line.a.x, line.a.y, line.b.x, line.b.y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, line.b.x, line.b.y);
        queueTrendPriceLabels(drawing, displayName, onLineObject);
      } else if (drawing.type === "partial-price-line") {
        const y = a.y;
        drawLine(ctx, Math.min(a.x, b.x), y, Math.max(a.x, b.x), y);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, b.x, y);
        queuePriceAxisLabel(drawing, displayName, onLineObject);
        queueTimeAxisLabel(drawing, 0, displayName, onTimeObject);
        queueTimeAxisLabel(drawing, 1, displayName, onTimeObject);
      } else if (isFibonacciTool(drawing.type)) {
        renderFibonacciTool(ctx, drawing, a, b, view, time, displayName, onLineObject);
      } else if (drawing.type === "parallel-channel") {
        renderParallelChannel(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "regression-channel") {
        renderRegressionChannel(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "pitchfork") {
        renderPitchfork(ctx, drawing, a, b, view, time, displayName);
      } else if (drawing.type === "gann-fan") {
        renderGannFan(ctx, drawing, a, b, view, displayName);
      } else if (drawing.type === "gann-grid") {
        renderGannGrid(ctx, drawing, a, b, view, displayName);
      } else if (isMeasurementTool(drawing.type)) {
        renderMeasurementTool(ctx, drawing, a, b, view, time, displayName, this.positionRiskSettings, onLineObject, onTimeObject);
      } else if (drawing.type === "ellipse") {
        renderEllipse(ctx, drawing, a, b, displayName);
      } else if (drawing.type === "triangle") {
        renderTriangle(ctx, drawing, a, b, displayName);
      } else if (drawing.type === "brush") {
        renderBrush(ctx, drawing, view, time);
      } else if (isZoneTool(drawing.type)) {
        const box = zoneRenderBox(drawing, a, b, view);
        ctx.globalAlpha = clamp01(drawing.fillOpacity ?? 0.18);
        ctx.fillRect(box.left, box.top, box.width, box.height);
        ctx.globalAlpha = clamp01(drawing.opacity ?? 1);
        ctx.strokeRect(box.left, box.top, box.width, box.height);
        if (drawing.showLabel !== false) drawObjectName(ctx, displayName, drawing.color, box.right, box.top + 12);
        queueZonePriceLabels(drawing, displayName, onLineObject);
        queueZoneTimeLabels(drawing, displayName, onTimeObject);
      } else {
        if (drawing.showLabel !== false) ctx.fillText(drawing.text || t("draw.text"), a.x + 4, a.y - 4);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
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

  private setSelection(ids: string[], primary: string | null | undefined = undefined, emit = false): void {
    const valid = ids.filter((id) => this.drawings.some((drawing) => drawing.id === id));
    this.selectedIds = new Set(valid);
    this.selectedId = primary && this.selectedIds.has(primary) ? primary : (lastOf(valid) ?? null);
    this.summaryRevision++;
    if (emit) this.changed();
  }

  private toggleSelection(id: string): void {
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

  private pruneSelection(): void {
    const validIds = new Set(this.drawings.map((drawing) => drawing.id));
    this.selectedIds = new Set([...this.selectedIds].filter((id) => validIds.has(id)));
    this.selectedId = this.selectedId && this.selectedIds.has(this.selectedId) ? this.selectedId : (lastOf([...this.selectedIds]) ?? null);
  }

  private selectedInDrawOrder(): Drawing[] {
    return this.drawings.filter((drawing) => this.selectedIds.has(drawing.id));
  }

  private updateSelectedBatch(mutator: (drawing: Drawing) => void): void {
    const selected = this.selectedInDrawOrder();
    if (!selected.length) return;
    this.snapshot();
    for (const drawing of selected) {
      mutator(drawing);
      normalizeDrawingStyleInPlace(drawing);
      normalizeDrawingPointsInPlace(drawing, 0);
    }
    this.changed();
  }

  private snapshot(): void { this.pushHistory(structuredClone(this.drawings)); }

  private pushHistory(previous: Drawing[]): void {
    this.undoStack.push(previous);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  /** A drag is one undo step; a click that only selects adds none and keeps the redo stack. */
  private commitGesture(): void {
    if (this.gestureBefore && JSON.stringify(this.gestureBefore) !== JSON.stringify(this.drawings)) this.pushHistory(this.gestureBefore);
    this.gestureBefore = null;
  }

  private changed(transient = false): void {
    this.displayNameCache = null;
    this.summaryRevision++;
    this.onChange(structuredClone(this.drawings.filter((drawing) => drawing.id !== this.draft?.id)), transient);
  }

  private selectionKey(): string { return `${this.selectedId ?? ""}|${[...this.selectedIds].join(",")}`; }

  private drawSelection(
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
