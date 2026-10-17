import { buildGexWallRows, type GexWallSurface } from "../gexWall.js";
import { placeVerticalLabels } from "../../../core/axisLabelUtils.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorSettings,
} from "../types.js";
import { uiColor, gexFlipColorDefault, gexMaxPainColorDefault, gexWallTagTextColor } from "../../../core/ui/seriesPalette.js";

type OptionsGexBase = "BTC" | "ETH" | "SOL" | "HYPE" | "XRP";

export interface OptionsGexWallSettings extends IndicatorSettings {
  base: "auto" | OptionsGexBase;
  maxExpiryDays: number;
  strikeCount: number;
  showLevels: boolean;
  showZones: boolean;
  showStrikeBars: boolean;
  callColor: string;
  putColor: string;
  flipColor: string;
  maxPainColor: string;
  showPlotLabel: boolean;
}

type OptionsGexPreparedData = IndicatorPreparedData<never, Record<string, unknown> & {
  base: string;
  surface?: GexWallSurface;
}> & {
  meta: Record<string, unknown> & { base: string; surface?: GexWallSurface };
};

type CacheEntry =
  | { status: "loading"; promise: Promise<void>; surface?: GexWallSurface; error?: string; requestedAt: number }
  | { status: "ok"; surface: GexWallSurface; requestedAt: number }
  | { status: "error"; error: string; requestedAt: number; surface?: GexWallSurface };

interface AxisLevelTag {
  desiredY: number;
  priority: number;
  boxH: number;
  text: string;
  color: string;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function inferBase(settings: OptionsGexWallSettings, market: string | undefined): OptionsGexBase {
  if (settings.base !== "auto") return settings.base;
  const symbol = (market ?? "").toUpperCase().split(":").pop()?.replace(/[^A-Z0-9]/g, "") ?? "";
  for (const base of ["HYPE", "XRP", "SOL", "ETH", "BTC"] as const) {
    if (symbol.startsWith(base)) return base;
  }
  return "BTC";
}

function cacheKey(base: string, maxExpiryDays: number): string {
  return `${base}:${maxExpiryDays}`;
}

function normalizeMaxExpiryDays(value: number): number {
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : 60;
}

function normalizeStrikeCount(value: number): number {
  const count = Math.round(Number(value));
  if (!Number.isFinite(count)) return 8;
  return Math.max(3, Math.min(20, count));
}

function requestSurface(base: OptionsGexBase, maxExpiryDays: number, onUpdate: () => void): CacheEntry {
  const key = cacheKey(base, maxExpiryDays);
  const existing = cache.get(key);
  const now = Date.now();
  if (existing && now - existing.requestedAt < CACHE_TTL_MS) return existing;
  const entry: CacheEntry = {
    status: "loading",
    requestedAt: now,
    promise: indicatorDataSource().fetchOptionsGexSurface({ base, maxExpiryDays })
      .then((surface) => {
        cache.set(key, { status: "ok", surface, requestedAt: Date.now() });
        onUpdate();
      })
      .catch((reason) => {
        cache.set(key, {
          status: "error",
          error: reason instanceof Error ? reason.message : "options gex load failed",
          requestedAt: Date.now(),
          surface: existing && "surface" in existing ? existing.surface : undefined,
        });
        onUpdate();
      }),
    surface: existing && "surface" in existing ? existing.surface : undefined,
  };
  cache.set(key, entry);
  return entry;
}

function prepareOptionsGexWall(ctx: IndicatorDrawContext<OptionsGexWallSettings>): OptionsGexPreparedData {
  if (!ctx.instance.visible) {
    return { status: "hidden", points: [], meta: { base: "" }, message: "hidden" };
  }
  const base = inferBase(ctx.settings, ctx.chart?.market);
  const entry = requestSurface(base, normalizeMaxExpiryDays(ctx.settings.maxExpiryDays), ctx.requestRefresh);
  if (entry.status === "ok") {
    return { status: "ok", points: [], meta: { base, surface: entry.surface } };
  }
  if (entry.surface) {
    return {
      status: entry.status === "error" ? "error" : "loading",
      points: [],
      meta: { base, surface: entry.surface },
      message: entry.status === "error" ? entry.error : "loading",
      error: entry.status === "error" ? entry.error : undefined,
    };
  }
  return {
    status: entry.status === "error" ? "error" : "loading",
    points: [],
    meta: { base },
    message: entry.status === "error" ? entry.error : "loading",
    error: entry.status === "error" ? entry.error : undefined,
  };
}

function asData(prepared: IndicatorPreparedData | undefined): OptionsGexPreparedData {
  return prepared as OptionsGexPreparedData;
}

function drawLine(ctx: IndicatorDrawContext<OptionsGexWallSettings>, price: number | null, color: string): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  const y = ctx.view.yOfPrice(price);
  if (y < ctx.view.area.top || y > ctx.view.area.top + ctx.view.area.height) return null;
  const canvas = ctx.ctx;
  const right = ctx.view.area.left + ctx.view.area.width;
  canvas.save();
  canvas.strokeStyle = color;
  canvas.globalAlpha = 0.75;
  canvas.setLineDash([6, 4]);
  canvas.beginPath();
  canvas.moveTo(ctx.view.area.left, y + 0.5);
  canvas.lineTo(right, y + 0.5);
  canvas.stroke();
  canvas.restore();
  return y;
}

function drawZone(
  ctx: IndicatorDrawContext<OptionsGexWallSettings>,
  zone: { priceLow: number; priceHigh: number } | null | undefined,
  color: string,
): void {
  if (!zone || !Number.isFinite(zone.priceLow) || !Number.isFinite(zone.priceHigh)) return;
  const area = ctx.view.area;
  const yLow = ctx.view.yOfPrice(zone.priceLow);
  const yHigh = ctx.view.yOfPrice(zone.priceHigh);
  const top = Math.max(area.top, Math.min(yLow, yHigh));
  const bottom = Math.min(area.top + area.height, Math.max(yLow, yHigh));
  if (!(bottom > top)) return;
  const canvas = ctx.ctx;
  canvas.save();
  canvas.fillStyle = color;
  canvas.globalAlpha = 0.12;
  canvas.fillRect(area.left, top, area.width, bottom - top);
  canvas.restore();
}

function axisLevelText(base: string, name: string, price: number, confidence?: number | null): string {
  const confidenceText = confidence == null || !Number.isFinite(confidence)
    ? ""
    : ` ${(Math.max(0, Math.min(1, confidence)) * 100).toFixed(0)}%`;
  return `${base} ${name}${confidenceText} ${price.toFixed(0)}`;
}

function drawAxisLevelTags(ctx: IndicatorDrawContext<OptionsGexWallSettings>, tags: AxisLevelTag[]): void {
  if (!tags.length) return;
  const labels = placeVerticalLabels(tags, ctx.view.area.top + 6, ctx.view.area.top + ctx.view.area.height - 6, 3);
  const canvas = ctx.ctx;
  const right = ctx.view.area.left + ctx.view.area.width;
  canvas.save();
  canvas.font = "10px ui-monospace, monospace";
  canvas.textAlign = "right";
  canvas.textBaseline = "middle";
  for (const tag of labels) {
    const padX = 5;
    const textWidth = Math.ceil(canvas.measureText(tag.text).width);
    const boxW = Math.min(188, textWidth + padX * 2);
    const boxX = right - boxW - 3;
    canvas.fillStyle = tag.color;
    canvas.globalAlpha = 0.92;
    canvas.fillRect(boxX, tag.y - tag.boxH / 2, boxW, tag.boxH);
    canvas.globalAlpha = 1;
    canvas.fillStyle = gexWallTagTextColor;
    canvas.fillText(tag.text, boxX + boxW - padX, tag.y);
    canvas.strokeStyle = tag.color;
    canvas.beginPath();
    canvas.moveTo(right - 1, tag.desiredY);
    canvas.lineTo(boxX + boxW, tag.y);
    canvas.stroke();
  }
  canvas.restore();
}

function drawOptionsGexWall(ctx: IndicatorDrawContext<OptionsGexWallSettings>, prepared?: IndicatorPreparedData): void {
  const data = asData(prepared ?? prepareOptionsGexWall(ctx));
  const surface = data.meta.surface;
  if (!surface) return;
  const canvas = ctx.ctx;
  const right = ctx.view.area.left + ctx.view.area.width;

  if (ctx.settings.showZones !== false) {
    drawZone(ctx, surface.callWallZone, ctx.settings.callColor);
    drawZone(ctx, surface.putWallZone, ctx.settings.putColor);
    drawZone(ctx, surface.strikeNetGexCrossingZone, ctx.settings.flipColor);
  }

  if (ctx.settings.showLevels) {
    const tags: AxisLevelTag[] = [];
    const days = normalizeMaxExpiryDays(ctx.settings.maxExpiryDays);
    const addLevel = (price: number | null, name: string, color: string, priority: number, confidence?: number | null): void => {
      const y = drawLine(ctx, price, color);
      if (y == null || price == null) return;
      const text = axisLevelText(data.meta.base, `${days}d ${name}`, price, confidence);
      tags.push({ desiredY: y, priority, boxH: 15, text, color });
      ctx.queuePriceLabel?.(price, text, color, priority);
    };
    addLevel(surface.strikeNetGexCrossing, "net GEX cross", ctx.settings.flipColor, 100, surface.strikeNetGexCrossingZone?.confidence);
    addLevel(surface.maxPain, "max pain", ctx.settings.maxPainColor, 90);
    addLevel(surface.callWall, "call wall", ctx.settings.callColor, 80, surface.callWallZone?.confidence);
    addLevel(surface.putWall, "put wall", ctx.settings.putColor, 80, surface.putWallZone?.confidence);
    if (ctx.settings.showPlotLabel !== false) drawAxisLevelTags(ctx, tags);
  }

  if (!ctx.settings.showStrikeBars) return;
  const rows = buildGexWallRows(surface, "net", normalizeStrikeCount(ctx.settings.strikeCount));
  const maxBarWidth = Math.max(72, Math.min(220, ctx.view.area.width * 0.22));
  canvas.save();
  canvas.font = "11px ui-monospace, monospace";
  canvas.textBaseline = "middle";
  for (const row of rows) {
    const y = ctx.view.yOfPrice(row.strike);
    if (y < ctx.view.area.top + 8 || y > ctx.view.area.top + ctx.view.area.height - 8) continue;
    const magnitude = Math.abs(row.netValueUsd);
    const rowMax = Math.max(...rows.map((item) => Math.abs(item.netValueUsd)), 1);
    const width = maxBarWidth * magnitude / rowMax;
    const color = row.netValueUsd < 0 ? ctx.settings.putColor : ctx.settings.callColor;
    canvas.globalAlpha = 0.82;
    canvas.fillStyle = color;
    canvas.fillRect(right - width - 14, y - 3, width, 6);
    canvas.globalAlpha = 1;
  }
  canvas.restore();
}

function headerLabel(ctx: { settings: OptionsGexWallSettings; chart?: { market: string }; prepared?: IndicatorPreparedData }): string {
  if (ctx.settings.showPlotLabel === false) return "";
  const data = ctx.prepared as OptionsGexPreparedData | undefined;
  const base = data?.meta?.base || inferBase(ctx.settings, ctx.chart?.market);
  const status = data?.status && data.status !== "ok" ? ` · ${data.status}` : "";
  return `Options GEX Wall · ${base} · ${ctx.settings.maxExpiryDays}d${status}`;
}

export const optionsGexWallIndicatorDefinition: IndicatorDefinition<OptionsGexWallSettings> = {
  type: "options-gex-wall",
  name: "Options GEX Wall",
  category: "derivatives",
  defaultPane: "overlay",
  canOverlay: true,
  paneHeight: 96,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  defaultSettings: () => ({
    base: "auto",
    maxExpiryDays: 60,
    strikeCount: 8,
    showLevels: true,
    showZones: true,
    showStrikeBars: true,
    callColor: uiColor.buy,
    putColor: uiColor.sell,
    flipColor: gexFlipColorDefault,
    maxPainColor: gexMaxPainColorDefault,
    showPlotLabel: true,
  }),
  settingsSchema: {
    sections: [{
      title: "Options GEX",
      titleKey: "indicator.optionsGexWall.section.main",
      fields: [
        { kind: "select", key: "base", label: "Base", labelKey: "indicator.optionsGexWall.base", options: [{ label: "Auto", value: "auto", labelKey: "indicator.optionsGexWall.base.auto" }, { label: "BTC", value: "BTC" }, { label: "ETH", value: "ETH" }, { label: "SOL", value: "SOL" }, { label: "HYPE", value: "HYPE" }, { label: "XRP", value: "XRP" }], requiresRecalc: true },
        { kind: "select", key: "maxExpiryDays", label: "Expiry", labelKey: "indicator.optionsGexWall.maxExpiryDays", options: [{ label: "7d", value: 7 }, { label: "30d", value: 30 }, { label: "60d", value: 60 }, { label: "90d", value: 90 }], requiresRecalc: true },
        { kind: "number", key: "strikeCount", label: "Strikes", labelKey: "indicator.optionsGexWall.strikeCount", min: 3, max: 20, step: 1 },
        { kind: "boolean", key: "showLevels", label: "Levels", labelKey: "indicator.optionsGexWall.showLevels" },
        { kind: "boolean", key: "showZones", label: "Zones", labelKey: "indicator.optionsGexWall.showZones" },
        { kind: "boolean", key: "showStrikeBars", label: "Strike bars", labelKey: "indicator.optionsGexWall.showStrikeBars" },
        { kind: "color", key: "callColor", label: "Call color", labelKey: "indicator.optionsGexWall.callColor" },
        { kind: "color", key: "putColor", label: "Put color", labelKey: "indicator.optionsGexWall.putColor" },
        { kind: "color", key: "flipColor", label: "Net GEX crossing color", labelKey: "indicator.optionsGexWall.flipColor" },
        { kind: "color", key: "maxPainColor", label: "Max pain color", labelKey: "indicator.optionsGexWall.maxPainColor" },
        { kind: "boolean", key: "showPlotLabel", label: "Show Header Label", labelKey: "indicator.common.showPlotLabel" },
      ],
    }],
  },
  getHeaderLabel: headerLabel,
  prepareData: prepareOptionsGexWall,
  drawPriceOverlay: drawOptionsGexWall,
};
