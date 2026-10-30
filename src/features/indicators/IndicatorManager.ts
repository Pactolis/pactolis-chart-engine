import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { ChartChange } from "../../core/render/scene/chartScene.js";
import type { AnalysisIndicatorSnapshot } from "../../core/analysisSnapshot.js";
import { normalizeOrderFlowProfileSettings } from "../../core/orderFlowProfileSettings.js";
import { uiColor, indicatorPaneBackgroundColor } from "../../core/ui/seriesPalette.js";
import { defaultIndicatorPlacement, getIndicatorDefinition, isIndicatorPlacementSupported } from "./registry.js";
import { chartLocale } from "../../core/chartLocale.js";
import { incrementPerformanceCounter, measurePerformance } from "../../core/performanceTelemetry.js";
import { IndicatorPrepareCache } from "./prepareCache.js";
import { buildIndicatorAnalysisSnapshot } from "./analysisSnapshot.js";
import {
  createIndicatorPaneHeadersModel,
  type IndicatorPaneHeaderView,
  type IndicatorPaneHeadersModel,
} from "./indicatorPaneHeaders.js";
import {
  INDICATOR_SETTINGS_MODAL_DISMISS_EVENT,
  INDICATOR_SETTINGS_MODAL_REQUEST_EVENT,
  type IndicatorSettingsModalCloseReason,
  type IndicatorSettingsModalDismissDetail,
  type IndicatorSettingsModalRequestDetail,
} from "./indicatorSettingsModalContract.js";
import type {
  IndicatorChartContext,
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorInstance,
  IndicatorPaneRect,
  IndicatorPaneRender,
  IndicatorSettings,
  IndicatorCrosshair,
  IndicatorPlacement,
  IndicatorPreparedData,
} from "./types.js";

const HEADER_H = 24;
const COLLAPSED_PANE_H = 28;
const MIN_PANE_H = 60;
const MIN_MAIN_CHART_H = 80;

interface IndicatorManagerOptions {
  ownerDocument: Document;
  root: HTMLElement;
  initial?: IndicatorInstance[];
  onChange: (instances: IndicatorInstance[]) => void;
  onLayoutChange: () => void;
  /** Request a chart frame; omitted `changes` means a full (`ChartChange.All`) invalidation. */
  onInvalidate: (changes?: ChartChange) => void;
  getChartContext?: () => IndicatorChartContext;
  queuePriceLabel?: (price: number, text: string, color: string, priority?: number) => void;
  /** View model the ChartSurface renders pane headers from. */
  headers?: IndicatorPaneHeadersModel;
}

function cloneInstances(value?: IndicatorInstance[]): IndicatorInstance[] {
  if (!value?.length) return [];
  return structuredClone(value)
    .map(normalizeInstance)
    .sort((a, b) => a.order - b.order);
}

function normalizeInstance(item: IndicatorInstance): IndicatorInstance {
  const definition = getIndicatorDefinition(item.type);
  if (!definition) {
    return {
      ...item,
      visible: item.visible !== false,
      paneHeight: normalizePaneHeight(item.paneHeight, 96),
      collapsed: item.collapsed === true,
      placement: item.placement ?? "separate-pane",
      settings: structuredClone(item.settings ?? {}),
    };
  }
  const defaults = structuredClone(definition.defaultSettings()) as IndicatorSettings;
  const rawSettings = structuredClone(item.type === "volume-profile"
    ? normalizeOrderFlowProfileSettings(item.settings as Record<string, unknown>)
    : item.settings);
  migrateLegacyIndicatorSettings(rawSettings);
  migrateLegacyTypeSettings(item.type, rawSettings);
  const settings = { ...defaults, ...rawSettings };
  if ((item.type === "moving-average" || item.type === "vwap") && !Array.isArray(rawSettings.lines)) {
    settings.lines = [];
  }
  const placement = isIndicatorPlacementSupported(definition, item.placement)
    ? item.placement
    : defaultIndicatorPlacement(definition);
  const paneHeight = normalizePaneHeight(item.paneHeight, definition.paneHeight);
  const title = !item.title || (item.type === "volume-profile" && item.title === "Volume Profile")
    ? definition.name
    : item.title;
  return {
    ...item,
    title,
    visible: item.visible !== false,
    paneHeight,
    collapsed: item.collapsed === true,
    placement,
    settings,
  };
}

function normalizePaneHeight(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(MIN_PANE_H, Math.round(numeric));
}

function migrateLegacyTypeSettings(type: string, settings: IndicatorSettings): void {
  if (type === "cvd") {
    delete settings.tradeSizeFilter;
    delete settings.marketTypes;
    delete settings.exchanges;
    return;
  }

  if (type === "moving-average" && !Array.isArray(settings.lines)) {
    const hasLegacy = ["periods", "method", "sourceTimeframe", "color1", "color2", "color3"]
      .some((key) => Object.prototype.hasOwnProperty.call(settings, key));
    if (!hasLegacy) return;
    const periods = String(settings.periods ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 8);
    const method = settings.method === "ema" ? "ema" : "sma";
    const timeframe = settings.sourceTimeframe === "daily" || settings.sourceTimeframe === "weekly"
      ? settings.sourceTimeframe
      : "chart";
    settings.lines = periods.map((period, index) => ({
      id: `legacy-${index}`,
      method,
      period,
      timeframe,
      color: typeof settings[`color${index + 1}`] === "string"
        ? settings[`color${index + 1}`]
        : undefined,
      enabled: true,
    }));
    return;
  }

  if (type === "vwap" && !Array.isArray(settings.lines)) {
    const hasLegacy = ["family", "period", "rollingWindowDays", "color", "showBands", "bandSigma", "bandColor"]
      .some((key) => Object.prototype.hasOwnProperty.call(settings, key));
    if (!hasLegacy) return;
    const family = settings.family === "rolling" || settings.family === "previous" ? settings.family : "current";
    const allowedPeriods = new Set(["daily", "weekly", "monthly", "quarterly", "half-yearly", "yearly"]);
    const period = allowedPeriods.has(String(settings.period)) ? settings.period : "daily";
    settings.lines = [{
      id: "legacy-0",
      enabled: true,
      family,
      period,
      rollingWindowDays: typeof settings.rollingWindowDays === "number" ? settings.rollingWindowDays : 1,
      color: settings.color,
      showBands: settings.showBands === true,
      bandSigma: typeof settings.bandSigma === "number" ? settings.bandSigma : 1,
      bandColor: settings.bandColor,
    }];
  }
}

function migrateLegacyIndicatorSettings(settings: IndicatorSettings): void {
  const legacyScaleLabel = settings.showScaleLabel;
  if (typeof legacyScaleLabel !== "boolean") return;
  if (typeof settings.showLastValueLabel !== "boolean") settings.showLastValueLabel = legacyScaleLabel;
  if (typeof settings.showReadout !== "boolean") settings.showReadout = legacyScaleLabel;
}

function instancePlacement(instance: IndicatorInstance): IndicatorPlacement {
  const definition = getIndicatorDefinition(instance.type);
  if (!definition) return "separate-pane";
  return isIndicatorPlacementSupported(definition, instance.placement)
    ? instance.placement
    : defaultIndicatorPlacement(definition);
}

function isSeparatePane(instance: IndicatorInstance): boolean {
  return instancePlacement(instance) === "separate-pane";
}

function paneHeightForInstance(instance: IndicatorInstance): number {
  if (instance.collapsed) return COLLAPSED_PANE_H;
  const definition = getIndicatorDefinition(instance.type);
  return normalizePaneHeight(instance.paneHeight, definition?.paneHeight ?? 96);
}

function colorVisibilityKey(key: string): string {
  return `${key}Visible`;
}

function effectiveSettings(definition: IndicatorDefinition, settings: IndicatorSettings): IndicatorSettings {
  let effective: IndicatorSettings | null = null;
  for (const section of definition.settingsSchema.sections) {
    for (const field of section.fields) {
      if (field.kind !== "color" || settings[colorVisibilityKey(field.key)] !== false) continue;
      effective ??= { ...settings };
      effective[field.key] = "transparent";
    }
  }
  return effective ?? settings;
}

type TimeframeVisibilityUnit = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";

interface TimeframeVisibilityRule {
  enabled?: boolean;
  min?: number;
  max?: number;
}

const TIMEFRAME_VISIBILITY_LIMITS: Record<TimeframeVisibilityUnit, { min: number; max: number }> = {
  seconds: { min: 1, max: 59 },
  minutes: { min: 1, max: 59 },
  hours: { min: 1, max: 24 },
  days: { min: 1, max: 366 },
  weeks: { min: 1, max: 52 },
  months: { min: 1, max: 12 },
};

function timeframeVisibility(settings: IndicatorSettings): Record<string, TimeframeVisibilityRule> {
  return asObject(settings.timeframeVisibility) as Record<string, TimeframeVisibilityRule>;
}

function timeframeUnitAndValue(timeframe: string, intervalMs: number): { unit: TimeframeVisibilityUnit; value: number } {
  const match = /^(\d+)([smhdwM])$/.exec(timeframe);
  if (match) {
    const value = Math.max(1, Number(match[1]));
    const unitBySuffix: Record<string, TimeframeVisibilityUnit> = {
      s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks", M: "months",
    };
    return { unit: unitBySuffix[match[2]], value };
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (intervalMs < minute) return { unit: "seconds", value: Math.max(1, Math.round(intervalMs / 1000)) };
  if (intervalMs < hour) return { unit: "minutes", value: Math.max(1, Math.round(intervalMs / minute)) };
  if (intervalMs < day) return { unit: "hours", value: Math.max(1, Math.round(intervalMs / hour)) };
  if (intervalMs < 7 * day) return { unit: "days", value: Math.max(1, Math.round(intervalMs / day)) };
  return { unit: "weeks", value: Math.max(1, Math.round(intervalMs / (7 * day))) };
}

function visibleAtTimeframe(settings: IndicatorSettings, chart?: IndicatorChartContext): boolean {
  if (!chart) return true;
  const { unit, value } = timeframeUnitAndValue(chart.timeframe, chart.intervalMs);
  const limits = TIMEFRAME_VISIBILITY_LIMITS[unit];
  const rule = timeframeVisibility(settings)[unit];
  if (rule?.enabled === false) return false;
  const min = Math.max(limits.min, Number.isFinite(rule?.min) ? Number(rule.min) : limits.min);
  const max = Math.min(limits.max, Number.isFinite(rule?.max) ? Number(rule.max) : limits.max);
  return value >= Math.min(min, max) && value <= Math.max(min, max);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class IndicatorManager {
  private ownerDocument: Document;
  private readonly root: HTMLElement;
  private readonly onChange: (instances: IndicatorInstance[]) => void;
  private readonly onLayoutChange: () => void;
  private readonly onInvalidate: (changes?: ChartChange) => void;
  private readonly getChartContext?: () => IndicatorChartContext;
  private readonly queuePriceLabel?: (price: number, text: string, color: string, priority?: number) => void;
  private readonly headers: IndicatorPaneHeadersModel;
  private readonly unsubscribeHeaderLocale: () => void;
  private instances: IndicatorInstance[];
  private latestView: View | null = null;
  private lastVisibilityTimeframe = "";
  private maximizedPane: "chart" | string | null = null;
  private readonly preparedDataCache = new IndicatorPrepareCache();
  private settingsModalToken = 0;
  private lastRemovedSnapshot: IndicatorInstance[] | null = null;
  private activeSettingsSession: {
    instanceId: string;
    token: number;
    disposed: boolean;
  } | null = null;

  private renderRevision = 0;
  private cachedPaneRenderRevision = -1;
  private cachedPaneRenderMaximized: "chart" | string | null = null;
  private cachedPaneRenderSubPanesH = -1;
  private cachedPaneRenderTimeframe = "";
  private cachedPaneRenders: IndicatorPaneRender[] = [];

  private cachedPriceOverlayRevision = -1;
  private cachedPriceOverlayTimeframe = "";
  private cachedPriceOverlayRenders: IndicatorPaneRender[] = [];

  constructor(options: IndicatorManagerOptions) {
    this.ownerDocument = options.ownerDocument;
    this.root = options.root;
    this.instances = cloneInstances(options.initial);
    this.onChange = options.onChange;
    this.onLayoutChange = options.onLayoutChange;
    this.onInvalidate = options.onInvalidate;
    this.getChartContext = options.getChartContext;
    this.queuePriceLabel = options.queuePriceLabel;

    this.headers = options.headers ?? createIndicatorPaneHeadersModel();
    this.headers.commands = {
      toggleCollapsed: (id) => this.toggleCollapsed(id),
      move: (id, direction) => this.moveIndicator(id, direction),
      toggleVisible: (id) => this.toggleVisible(id),
      openSettings: (id, trigger) => {
        const instance = this.instances.find((item) => item.id === id);
        if (instance) this.requestSettings(instance, trigger);
      },
      refresh: () => this.onInvalidate(),
      remove: (id) => this.removeIndicator(id),
      undoRemove: () => this.undoRemoveIndicator(),
      dismissUndo: () => this.dismissRemoveUndo(),
      beginResize: (event, id) => this.beginPaneResize(event, id),
    };
    this.renderHeaders();
    this.unsubscribeHeaderLocale = chartLocale().onLocaleChange(() => this.renderHeaders());
  }

  dispose(): void {
    this.dismissSettingsSession("dispose");
    this.unsubscribeHeaderLocale();
    this.preparedDataCache.clear();
    this.headers.panes = [];
    this.headers.lastRemovedTitle = "";
    this.lastRemovedSnapshot = null;
    this.headers.commands = null;
  }

  updateOwnerDocument(ownerDocument: Document): void {
    if (ownerDocument === this.ownerDocument) return;
    this.dismissSettingsSession("dispose");
    this.ownerDocument = ownerDocument;
    this.renderHeaders();
  }

  peekInstances(): readonly IndicatorInstance[] {
    return this.instances;
  }

  getRenderRevision(): number {
    return this.renderRevision;
  }

  restore(instances?: IndicatorInstance[]): void {
    if (this.lastRemovedSnapshot) this.dismissRemoveUndo();
    this.preparedDataCache.clear();
    this.instances = cloneInstances(instances);
    this.renderRevision++;
    this.renderHeaders();
    if (this.latestView) this.layout(this.latestView);
    this.onLayoutChange();
    this.onInvalidate();
  }

  serialize(): IndicatorInstance[] {
    return structuredClone(this.instances);
  }

  listInstances(): IndicatorInstance[] {
    return this.serialize();
  }

  getAnalysisSnapshots(
    series: FootprintSeries,
    chart: { market: string; timeframe: string; intervalMs: number },
    range: [number, number],
    maxSamples = 20,
  ): AnalysisIndicatorSnapshot[] {
    return this.instances.map((instance) => buildIndicatorAnalysisSnapshot(
      instance,
      getIndicatorDefinition(instance.type),
      series,
      chart,
      range,
      maxSamples,
    ));
  }

  setIndicatorVisible(id: string, visible: boolean): void {
    const current = this.instances.find((item) => item.id === id);
    if (!current || current.visible === visible) return;
    this.dismissRemoveUndo();
    this.instances = this.instances.map((item) => item.id === id ? { ...item, visible } : item);
    this.emit(true, ChartChange.Visibility);
  }

  deleteIndicator(id: string): void {
    this.removeIndicator(id);
  }

  openIndicatorSettings(id: string): void {
    const instance = this.instances.find((item) => item.id === id);
    if (instance) this.requestSettings(instance, null);
  }

  totalPaneHeight(maximizedHeight?: number): number {
    if (this.maximizedPane === "chart") return 0;
    if (this.maximizedPane && typeof maximizedHeight === "number") return Math.max(1, maximizedHeight);
    return this.separateInstances().reduce((sum, instance) => sum + paneHeightForInstance(instance), 0);
  }

  toggleMaximizedPaneAt(y: number): boolean {
    const view = this.latestView;
    if (!view) return false;
    let target: "chart" | string | null = y < view.area.top + view.area.height ? "chart" : null;
    if (!target) {
      let top = view.area.top + view.area.height;
      for (const instance of this.renderedSeparateInstances()) {
        const height = this.maximizedPane === instance.id ? view.subPanesH : paneHeightForInstance(instance);
        if (y >= top && y < top + height) {
          target = instance.id;
          break;
        }
        top += height;
      }
    }
    if (!target) return false;
    this.setMaximizedPane(this.maximizedPane === target ? null : target);
    return true;
  }

  /** Shows only the chart pane, or brings every indicator pane back. */
  toggleChartPaneMaximized(): void {
    this.setMaximizedPane(this.maximizedPane === "chart" ? null : "chart");
  }

  private setMaximizedPane(target: "chart" | string | null): void {
    if (this.maximizedPane === target) return;
    this.maximizedPane = target;
    this.renderRevision++;
    this.renderHeaders();
    this.onLayoutChange();
    this.onInvalidate(ChartChange.Layout);
  }

  isChartPaneMaximized(): boolean {
    return this.maximizedPane === "chart";
  }

  hasSeparatePanes(): boolean {
    return this.separateInstances().length > 0;
  }

  isIndicatorPaneMaximized(): boolean {
    return this.maximizedPane !== null && this.maximizedPane !== "chart";
  }

  scalePane(id: string, factorMultiplier: number): boolean {
    const instance = this.instances.find((item) => item.id === id && isSeparatePane(item));
    if (!instance) return false;
    const factor = Math.max(0.05, Math.min(20, (Number(instance.settings.paneScaleFactor) || 1) * factorMultiplier));
    this.updateSettings(id, { ...instance.settings, paneScaleAuto: false, paneScaleFactor: factor });
    return true;
  }

  /** Switches the pane between auto and manual scale; the manual zoom factor survives the round trip. */
  togglePaneAutoScale(id: string): boolean {
    const instance = this.instances.find((item) => item.id === id && isSeparatePane(item));
    if (!instance) return false;
    this.updateSettings(id, { ...instance.settings, paneScaleAuto: instance.settings.paneScaleAuto === false });
    return true;
  }

  resetPaneScale(id: string): boolean {
    const instance = this.instances.find((item) => item.id === id && isSeparatePane(item));
    if (!instance) return false;
    const settings = { ...instance.settings };
    delete settings.paneScaleAuto;
    delete settings.paneScaleFactor;
    this.updateSettings(id, settings);
    return true;
  }

  private separateInstances(): IndicatorInstance[] {
    const chart = this.getChartContext?.();
    return this.instances.filter((instance) =>
      isSeparatePane(instance) && instance.visible !== false && visibleAtTimeframe(instance.settings, chart));
  }

  private renderedSeparateInstances(): IndicatorInstance[] {
    const instances = this.separateInstances();
    if (this.maximizedPane === "chart") return [];
    if (this.maximizedPane) return instances.filter((instance) => instance.id === this.maximizedPane);
    return instances;
  }

  getPaneRenders(): IndicatorPaneRender[] {
    const subPanesH = this.latestView?.subPanesH ?? 0;
    const timeframe = this.getChartContext?.()?.timeframe ?? "";

    if (
      this.cachedPaneRenderRevision === this.renderRevision
      && this.cachedPaneRenderMaximized === this.maximizedPane
      && this.cachedPaneRenderSubPanesH === subPanesH
      && this.cachedPaneRenderTimeframe === timeframe
    ) {
      return this.cachedPaneRenders;
    }

    const result = this.renderedSeparateInstances().map((instance) => {
      const definition = getIndicatorDefinition(instance.type);
      const height = this.maximizedPane === instance.id
        ? Math.max(1, this.latestView?.subPanesH ?? paneHeightForInstance(instance))
        : paneHeightForInstance(instance);
      const placement = instancePlacement(instance);
      return {
        id: instance.id,
        title: instance.title,
        height,
        visible: instance.visible,
        collapsed: instance.collapsed === true,
        placement,
        scaleMode: instance.settings.paneScaleMode === "log" ? "log" : "linear",
        toggleScaleMode: () => {
          const next = instance.settings.paneScaleMode === "log" ? "linear" : "log";
          this.updateSettings(instance.id, { ...instance.settings, paneScaleMode: next });
          return next;
        },
        draw: (ctx, view, series, rect, range, crosshair?: IndicatorCrosshair) => {
          if (instance.collapsed || definition?.inputSource === "view" || !definition?.drawSubPane) return;
          const drawSubPane = definition.drawSubPane;
          const drawContext = {
            ctx,
            view,
            series,
            rect,
            range,
            instance: instance as IndicatorInstance<IndicatorSettings>,
            settings: effectiveSettings(definition, instance.settings),
            chart: this.getChartContext?.(),
            crosshair,
            requestRefresh: () => this.onInvalidate(),
            queuePriceLabel: this.queuePriceLabel,
          };
          const prepared = this.prepareData(instance, definition, drawContext);
          incrementPerformanceCounter(`indicator.draw.${instance.type}`);
          this.updateHeaderLabel(instance, definition, prepared);
          measurePerformance(`indicator.draw.${instance.type}`, () => drawSubPane(drawContext, prepared));
        },
      } satisfies IndicatorPaneRender;
    });

    this.cachedPaneRenderRevision = this.renderRevision;
    this.cachedPaneRenderMaximized = this.maximizedPane;
    this.cachedPaneRenderSubPanesH = subPanesH;
    this.cachedPaneRenderTimeframe = timeframe;
    this.cachedPaneRenders = result;
    return result;
  }

  getPriceOverlayRenders(): IndicatorPaneRender[] {
    const chart = this.getChartContext?.();
    const timeframe = chart?.timeframe ?? "";

    if (
      this.cachedPriceOverlayRevision === this.renderRevision
      && this.cachedPriceOverlayTimeframe === timeframe
    ) {
      return this.cachedPriceOverlayRenders;
    }

    const result = this.instances.filter((instance) =>
      instancePlacement(instance) === "price-overlay" && visibleAtTimeframe(instance.settings, chart)).map((instance) => {
      const definition = getIndicatorDefinition(instance.type);
      return {
        id: instance.id,
        title: instance.title,
        height: 0,
        visible: instance.visible,
        collapsed: false,
        placement: "price-overlay",
        scaleMode: "linear",
        toggleScaleMode: () => "linear",
        draw: (ctx, view, series, rect, range, crosshair?: IndicatorCrosshair) => {
          if (definition?.inputSource === "view" || !definition?.drawPriceOverlay || instance.visible === false) return;
          const drawPriceOverlay = definition.drawPriceOverlay;
          const drawContext = {
            ctx,
            view,
            series,
            rect,
            range,
            instance: instance as IndicatorInstance<IndicatorSettings>,
            settings: effectiveSettings(definition, instance.settings),
            chart: this.getChartContext?.(),
            crosshair,
            requestRefresh: () => this.onInvalidate(),
          };
          const prepared = this.prepareData(instance, definition, drawContext);
          incrementPerformanceCounter(`indicator.draw.${instance.type}`);
          measurePerformance(`indicator.draw.${instance.type}`, () => drawPriceOverlay(drawContext, prepared));
        },
      } satisfies IndicatorPaneRender;
    });

    this.cachedPriceOverlayRevision = this.renderRevision;
    this.cachedPriceOverlayTimeframe = timeframe;
    this.cachedPriceOverlayRenders = result;
    return result;
  }

  layout(view: View): void {
    this.latestView = view;
    const visibilityTimeframe = this.getChartContext?.().timeframe ?? "";
    if (visibilityTimeframe !== this.lastVisibilityTimeframe) {
      this.lastVisibilityTimeframe = visibilityTimeframe;
      this.renderRevision++;
      this.renderHeaders();
      queueMicrotask(() => {
        this.onLayoutChange();
        this.onInvalidate(ChartChange.Visibility | ChartChange.Layout);
      });
    }
    this.positionHeaders(view);
  }

  private positionHeaders(view: View): void {
    const layer = this.headers.layer;
    if (layer.left !== view.area.left) layer.left = view.area.left;
    if (layer.top !== view.area.top) layer.top = view.area.top;
    if (layer.width !== view.area.width) layer.width = view.area.width;
    const layerHeight = view.area.height + view.subPanesH;
    if (layer.height !== layerHeight) layer.height = layerHeight;

    const instances = new Map(this.instances.map((instance) => [instance.id, instance]));
    let offset = 0;
    for (const pane of this.headers.panes) {
      const instance = instances.get(pane.id);
      if (!instance) continue;
      const height = this.maximizedPane === instance.id ? view.subPanesH : paneHeightForInstance(instance);
      const top = view.area.height + offset;
      const resizeTop = view.area.height + Math.max(HEADER_H, offset + height - 3);
      if (pane.top !== top) pane.top = top;
      if (pane.resizeTop !== resizeTop) pane.resizeTop = resizeTop;
      offset += height;
    }
  }

  private prepareData(
    instance: IndicatorInstance,
    definition: IndicatorDefinition,
    drawContext: IndicatorDrawContext,
  ): IndicatorPreparedData | undefined {
    if (!definition.prepareData || definition.inputSource === "view") return undefined;
    const compute = () => measurePerformance(
      `indicator.prepare.${instance.type}`,
      () => definition.prepareData!(drawContext),
    );
    const cachePolicy = definition.prepareCache;
    if (!cachePolicy) return compute();
    const maxAgeMs = typeof cachePolicy === "string" ? 0 : Math.max(1, cachePolicy.maxAgeMs);

    let computed = false;
    const prepared = this.preparedDataCache.resolve(instance.id, {
      definitionType: definition.type,
      instance,
      series: drawContext.series,
      rangeFrom: drawContext.range[0],
      rangeTo: drawContext.range[1],
      market: drawContext.chart?.market ?? "",
      timeframe: drawContext.chart?.timeframe ?? "",
      intervalMs: drawContext.chart?.intervalMs ?? drawContext.series.config.intervalMs,
      timeBucket: maxAgeMs > 0 ? Math.floor(Date.now() / maxAgeMs) : 0,
    }, () => {
      computed = true;
      return compute();
    });
    incrementPerformanceCounter(`indicator.prepare.cache.${computed ? "miss" : "hit"}.${instance.type}`);
    return prepared;
  }

  private headerLabel(
    instance: IndicatorInstance,
    definition = getIndicatorDefinition(instance.type),
    prepared?: IndicatorPreparedData,
  ): string {
    if (!definition?.getHeaderLabel) return instance.title;
    if (definition.inputSource === "view") return instance.title;
    try {
      const label = definition.getHeaderLabel({
        instance: instance as IndicatorInstance<IndicatorSettings>,
        settings: instance.settings,
        chart: this.getChartContext?.(),
        prepared,
      });
      return label.trim() || instance.title;
    } catch {
      return instance.title;
    }
  }

  private updateHeaderLabel(instance: IndicatorInstance, definition: IndicatorDefinition | undefined, prepared?: IndicatorPreparedData): void {
    const pane = this.headers.panes.find((item) => item.id === instance.id);
    if (!pane) return;
    const label = this.headerLabel(instance, definition, prepared);
    if (pane.label !== label) pane.label = label;
  }

  private removeIndicator(id: string): void {
    const instance = this.instances.find((item) => item.id === id);
    if (!instance) return;
    this.lastRemovedSnapshot = this.serialize();
    this.headers.lastRemovedTitle = instance.title;
    if (this.activeSettingsSession?.instanceId === id) this.dismissSettingsSession("dispose");
    this.preparedDataCache.delete(id);
    this.instances = this.instances.filter((item) => item.id !== id).map((item, order) => ({ ...item, order }));
    this.emit(true);
  }

  private undoRemoveIndicator(): void {
    const snapshot = this.lastRemovedSnapshot;
    if (!snapshot) return;
    this.lastRemovedSnapshot = null;
    this.headers.lastRemovedTitle = "";
    this.restore(snapshot);
    this.onChange(this.serialize());
  }

  private dismissRemoveUndo(): void {
    this.lastRemovedSnapshot = null;
    this.headers.lastRemovedTitle = "";
  }

  private toggleVisible(id: string): void {
    this.dismissRemoveUndo();
    this.instances = this.instances.map((item) => item.id === id ? { ...item, visible: !item.visible } : item);
    this.emit(true, ChartChange.Visibility);
  }

  private toggleCollapsed(id: string): void {
    this.dismissRemoveUndo();
    this.instances = this.instances.map((item) => item.id === id ? { ...item, collapsed: !item.collapsed } : item);
    this.emit(true, ChartChange.Visibility);
  }

  private moveIndicator(id: string, direction: -1 | 1): void {
    const next = [...this.instances].sort((a, b) => a.order - b.order);
    const index = next.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= next.length) return;
    this.dismissRemoveUndo();
    [next[index], next[target]] = [next[target], next[index]];
    this.instances = next.map((item, order) => ({ ...item, order }));
    this.emit(true, ChartChange.Style);
  }

  private setPaneHeight(id: string, height: number, persist: boolean): void {
    this.instances = this.instances.map((item) => item.id === id
      ? { ...item, collapsed: false, paneHeight: normalizePaneHeight(height, paneHeightForInstance(item)) }
      : item);
    this.renderRevision++;
    if (this.latestView) this.layout(this.latestView);
    this.onLayoutChange();
    this.onInvalidate(ChartChange.Layout);
    if (persist) { this.dismissRemoveUndo(); this.onChange(this.serialize()); }
  }

  private updateSettings(id: string, settings: IndicatorSettings): void {
    const current = this.instances.find((item) => item.id === id);
    const visibilityChanged = JSON.stringify(current?.settings.timeframeVisibility ?? null)
      !== JSON.stringify(settings.timeframeVisibility ?? null);
    this.dismissRemoveUndo();
    this.instances = this.instances.map((item) => item.id === id ? { ...item, settings } : item);
    this.emit(visibilityChanged, visibilityChanged ? ChartChange.Style | ChartChange.Visibility : ChartChange.Style);
  }

  /** `changes` names what the caller changed; a layout change is added when panes were re-laid out. */
  private emit(layoutChanged: boolean, changes: ChartChange = ChartChange.All): void {
    this.renderRevision++;
    this.renderHeaders();
    if (this.latestView) this.layout(this.latestView);
    this.onChange(this.serialize());
    if (layoutChanged) this.onLayoutChange();
    this.onInvalidate(layoutChanged ? changes | ChartChange.Layout : changes);
  }

  private renderHeaders(): void {
    const ordered = this.renderedSeparateInstances();
    this.headers.panes = ordered.map((instance, index): IndicatorPaneHeaderView => ({
      id: instance.id,
      type: instance.type,
      title: instance.title,
      label: this.headerLabel(instance),
      showLabel: instance.settings.showPlotLabel !== false,
      collapsed: instance.collapsed === true,
      visible: instance.visible !== false,
      canMoveUp: index > 0,
      canMoveDown: index < ordered.length - 1,
      top: 0,
      resizeTop: 0,
    }));
    this.headers.resizable = this.maximizedPane === null;
    if (this.latestView) this.positionHeaders(this.latestView);
  }

  private beginPaneResize(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const instance = this.instances.find((item) => item.id === id);
    if (!instance) return;
    const startY = event.clientY;
    const startHeight = Math.max(MIN_PANE_H, paneHeightForInstance(instance));
    const maxHeight = this.maxPaneHeightFor(id);
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const doc = target?.ownerDocument ?? this.root.ownerDocument;
    const win = doc.defaultView;
    try { target?.setPointerCapture(event.pointerId); } catch { /* synthetic/browser edge case */ }

    const onMove = (move: PointerEvent): void => {
      const nextHeight = Math.max(MIN_PANE_H, Math.min(maxHeight, startHeight - (move.clientY - startY)));
      this.setPaneHeight(id, nextHeight, false);
    };

    let ended = false;
    const onUp = (): void => {
      if (ended) return;
      ended = true;
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      win?.removeEventListener("pointerup", onUp);
      this.dismissRemoveUndo();
      this.emit(true);
    };

    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp, { once: true });
    win?.addEventListener("pointerup", onUp, { once: true });
  }

  private maxPaneHeightFor(id: string): number {
    const rootHeight = this.root.getBoundingClientRect().height;
    const otherPanes = this.separateInstances()
      .filter((item) => item.id !== id)
      .reduce((sum, item) => sum + paneHeightForInstance(item), 0);
    const timeAxisHeight = this.latestView?.chartLayoutOptions.timeAxisHeight ?? 24;
    const available = rootHeight - timeAxisHeight - MIN_MAIN_CHART_H - otherPanes;
    return Math.max(MIN_PANE_H, Math.round(Number.isFinite(available) ? available : 360));
  }

  private currentSettingsTrigger(instanceId: string, fallback: HTMLElement | null): HTMLElement | null {
    for (const candidate of this.root.querySelectorAll<HTMLElement>("[data-indicator-settings-trigger]")) {
      if (candidate.dataset.indicatorSettingsTrigger === instanceId) return candidate;
    }
    return fallback?.ownerDocument === this.ownerDocument ? fallback : null;
  }

  private requestSettings(instance: IndicatorInstance, trigger: HTMLElement | null): void {
    const definition = getIndicatorDefinition(instance.type);
    if (!definition) return;
    const previous = this.activeSettingsSession;
    if (previous && previous.instanceId === instance.id) {
      this.dispatchSettingsRequest(instance, trigger, previous.token);
      return;
    }
    if (previous) this.invalidateSettingsSession(previous);
    const session = { instanceId: instance.id, token: ++this.settingsModalToken, disposed: false };
    this.activeSettingsSession = session;
    this.dispatchSettingsRequest(instance, trigger, session.token);
  }

  private dispatchSettingsRequest(instance: IndicatorInstance, trigger: HTMLElement | null, token: number): void {
    const session = this.activeSettingsSession;
    if (!session || session.instanceId !== instance.id || session.token !== token || session.disposed) return;
    const liveTrigger = trigger?.ownerDocument === this.ownerDocument ? trigger : null;
    const definition = getIndicatorDefinition(instance.type);
    if (!definition) return;
    const detail: IndicatorSettingsModalRequestDetail = {
      instanceId: instance.id,
      title: instance.title,
      schema: structuredClone(definition.settingsSchema),
      initialSettings: structuredClone(instance.settings),
      trigger: liveTrigger,
      restoreFocus: () => {
        const currentTrigger = this.currentSettingsTrigger(instance.id, liveTrigger);
        if (currentTrigger?.isConnected && !currentTrigger.matches(":disabled")) currentTrigger.focus({ preventScroll: true });
      },
      token,
      commands: {
        preview: (settings) => {
          if (!this.isLiveSettingsSession(session) || !this.instances.some((item) => item.id === instance.id)) return;
          this.updateSettings(instance.id, structuredClone(settings));
        },
        save: (settings) => {
          if (!this.isLiveSettingsSession(session) || !this.instances.some((item) => item.id === instance.id)) return;
          this.updateSettings(instance.id, structuredClone(settings));
        },
        close: (reason) => {
          if (!this.isLiveSettingsSession(session)) return;
          this.invalidateSettingsSession(session);
          void reason;
        },
      },
    };
    const CustomEventCtor = this.ownerDocument.defaultView?.CustomEvent ?? (typeof CustomEvent === "function" ? CustomEvent : null);
    if (!CustomEventCtor) return;
    const event = new CustomEventCtor(INDICATOR_SETTINGS_MODAL_REQUEST_EVENT, { bubbles: false, cancelable: true, detail });
    this.ownerDocument.dispatchEvent(event);
    if (!event.defaultPrevented && this.activeSettingsSession?.token === token) this.invalidateSettingsSession(session);
  }

  private isLiveSettingsSession(session: { instanceId: string; token: number; disposed: boolean }): boolean {
    return this.activeSettingsSession === session
      && !session.disposed
      && this.instances.some((item) => item.id === session.instanceId);
  }

  private invalidateSettingsSession(session: { instanceId: string; token: number; disposed: boolean }): void {
    if (this.activeSettingsSession === session) this.activeSettingsSession = null;
    session.disposed = true;
  }

  private dismissSettingsSession(reason: IndicatorSettingsModalCloseReason): void {
    const session = this.activeSettingsSession;
    if (!session) return;
    const detail: IndicatorSettingsModalDismissDetail = { instanceId: session.instanceId, token: session.token, reason };
    const CustomEventCtor = this.ownerDocument.defaultView?.CustomEvent ?? (typeof CustomEvent === "function" ? CustomEvent : null);
    this.invalidateSettingsSession(session);
    if (!CustomEventCtor) return;
    this.ownerDocument.dispatchEvent(new CustomEventCtor(INDICATOR_SETTINGS_MODAL_DISMISS_EVENT, { bubbles: false, cancelable: true, detail }));
  }
}

export function drawIndicatorPaneBackground(
  ctx: CanvasRenderingContext2D,
  view: View,
  rect: IndicatorPaneRect,
): void {
  ctx.fillStyle = indicatorPaneBackgroundColor;
  ctx.fillRect(view.area.left, rect.top, view.area.width, rect.height);
  ctx.strokeStyle = uiColor.separator;
  ctx.beginPath();
  ctx.moveTo(view.area.left, rect.top + 0.5);
  ctx.lineTo(view.area.left + view.area.width, rect.top + 0.5);
  ctx.stroke();
}
