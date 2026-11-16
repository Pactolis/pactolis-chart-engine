/** Owns the drawing graph, cloned persistence boundaries, caches and undo/redo snapshots. Selection hooks are supplied by DrawingSelection; the graph is not duplicated between components. Depends on notifications and pure primitives, never on pointer editing. This mechanical move preserves existing in-place gesture updates and immutable history/host snapshots. */
import type { View } from "../../core/engine/view.js";
import { t } from "../../core/chartLocale.js";
import type { Drawing, DrawingContext, DrawingNamedPreset, DrawingPoint, DrawingStylePreset, DrawingTemplateState, DrawingType, PositionRiskSettings } from "../../core/drawingTypes.js";
import { DEFAULT_DRAWING_TEMPLATE_STATE, DEFAULT_POSITION_RISK_SETTINGS, applyStylePreset, drawingStylePresetFromDrawing, duplicateDrawing, lastOf, normalizeDrawing, normalizeDrawingPointsInPlace, normalizeDrawingStyleInPlace, normalizeDrawingTemplateState, normalizePositionRiskSettings, safeDrawingTypeLabel, summarizeMarketDrawings, type DrawingMarketSummary } from "./drawingPrimitives.js";
import { DrawingNotifications } from "./drawingNotifications.js";

export abstract class DrawingState extends DrawingNotifications {
  abstract get selected(): Drawing | null;
  protected abstract setSelection(ids: string[], primary?: string | null, emit?: boolean): void;
  protected abstract pruneSelection(): void;
  protected abstract selectedInDrawOrder(): Drawing[];

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

  setMarket(market: string): void {
    if (market === this.currentMarket) return;
    this.currentMarket = market;
    this.changed();
  }

  getMarket(): string {
    return this.currentMarket;
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
}
