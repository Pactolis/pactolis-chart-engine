import { tOr } from "../../../core/chartLocale.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type { FootprintBar } from "../../../core/types.js";
import {
  indicatorBadgeBg,
  indicatorBadgeBorder,
  indicatorReadoutTextColor,
  uiColor,
} from "../../../core/ui/seriesPalette.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type {
  LiveTradeEvent,
  LiveTradeEventKind,
  LiveTradeEventScope,
} from "../metricContracts.js";
import { compactNumber, compactUsd } from "../render/indicatorPaneUi.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorReadout,
  IndicatorSettings,
} from "../types.js";
import { registerIndicatorCleanup, runIndicatorCleanup } from "./stateRegistry.js";

export const MAX_LIVE_TRADE_EVENTS_PER_MARKET = 5_000;
export const MIN_BUBBLE_RADIUS_PX = 3;
export const MAX_BUBBLE_RADIUS_PX = 28;
export const DEFAULT_CLUSTER_CELL_PX = 8;
const RELATIVE_RECENT_WINDOW = 200;
const FIXED_REF_NOTIONAL_USD = 1_000_000;

export type LiveTradeBubblesKindsSetting = "both" | "trades" | "liquidations";
export type LiveTradeBubblesScaleMode = "relative" | "fixed";

export interface LiveTradeBubblesSettings extends IndicatorSettings {
  kinds: LiveTradeBubblesKindsSetting;
  scope: LiveTradeEventScope;
  minTradeNotionalUsd: number;
  minLiquidationNotionalUsd: number;
  sizeScale: number;
  scaleMode: LiveTradeBubblesScaleMode;
  opacity: number;
  showLabels: boolean;
  showPlotLabel: boolean;
}

export interface ProjectedBubbleInput {
  event: LiveTradeEvent;
  x: number;
  y: number;
}

export interface ClusteredBubble {
  kind: LiveTradeEventKind;
  side: LiveTradeEvent["side"];
  venue: string;
  x: number;
  y: number;
  time: number;
  price: number;
  qty: number;
  notionalUsd: number;
  count: number;
  sampled: boolean;
}

export interface RenderedBubble extends ClusteredBubble {
  radius: number;
  color: string;
}

interface ActiveSubscription {
  key: string;
  market: string;
  unsubscribe: () => void;
}

type LiveTradeBubblesPreparedMeta = Record<string, unknown> & {
  market: string;
  scope: LiveTradeEventScope;
  kinds: LiveTradeEventKind[];
  bubbles: RenderedBubble[];
  hovered: RenderedBubble | null;
  totalEvents: number;
};

type LiveTradeBubblesPreparedData = IndicatorPreparedData<never, LiveTradeBubblesPreparedMeta> & {
  meta: LiveTradeBubblesPreparedMeta;
};

const marketBuffers = new Map<string, LiveTradeEvent[]>();
const activeSubscriptions = new Map<string, ActiveSubscription>();

function normalizeMarketKey(market: string | undefined): string {
  return (market ?? "").trim().toUpperCase();
}

export function pushLiveTradeEvents(market: string, events: readonly LiveTradeEvent[]): void {
  if (!events.length) return;
  const key = normalizeMarketKey(market);
  if (!key) return;
  let buffer = marketBuffers.get(key);
  if (!buffer) {
    buffer = [];
    marketBuffers.set(key, buffer);
  }
  for (const event of events) {
    if (!event || !Number.isFinite(event.time) || !Number.isFinite(event.price) || !Number.isFinite(event.notionalUsd)) {
      continue;
    }
    buffer.push(event);
  }
  if (buffer.length > MAX_LIVE_TRADE_EVENTS_PER_MARKET) {
    buffer.splice(0, buffer.length - MAX_LIVE_TRADE_EVENTS_PER_MARKET);
  }
}

export function getLiveTradeEvents(market: string): readonly LiveTradeEvent[] {
  return marketBuffers.get(normalizeMarketKey(market)) ?? [];
}

export function clearLiveTradeEvents(market?: string): void {
  if (market === undefined) {
    marketBuffers.clear();
    return;
  }
  marketBuffers.delete(normalizeMarketKey(market));
}

export function resolveLiveTradeKinds(setting: LiveTradeBubblesKindsSetting | unknown): LiveTradeEventKind[] {
  if (setting === "trades") return ["trade"];
  if (setting === "liquidations") return ["liquidation"];
  return ["trade", "liquidation"];
}

function normalizeScope(scope: unknown): LiveTradeEventScope {
  return scope === "market" ? "market" : "base";
}

function normalizeScaleMode(mode: unknown): LiveTradeBubblesScaleMode {
  return mode === "fixed" ? "fixed" : "relative";
}

function finiteNonNegative(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function filterLiveTradeEvents(
  events: readonly LiveTradeEvent[],
  settings: Pick<LiveTradeBubblesSettings, "kinds" | "minTradeNotionalUsd" | "minLiquidationNotionalUsd">,
): LiveTradeEvent[] {
  const allowTrade = settings.kinds !== "liquidations";
  const allowLiq = settings.kinds !== "trades";
  const minTrade = finiteNonNegative(settings.minTradeNotionalUsd, 0);
  const minLiq = finiteNonNegative(settings.minLiquidationNotionalUsd, 0);

  const out: LiveTradeEvent[] = [];
  for (const event of events) {
    if (event.kind === "trade") {
      if (allowTrade && event.notionalUsd >= minTrade) out.push(event);
    } else if (event.kind === "liquidation") {
      if (allowLiq && event.notionalUsd >= minLiq) out.push(event);
    }
  }
  return out;
}

/**
 * Maps an event timestamp to an X pixel coordinate proportionally inside its
 * enclosing candle bar. Returns `null` when the event falls outside the bar series.
 */
export function eventXInBars(
  time: number,
  bars: readonly FootprintBar[],
  intervalMs: number,
  xOfIndex: (idx: number) => number,
): number | null {
  if (!bars.length || !(intervalMs > 0) || !Number.isFinite(time)) return null;
  if (time < bars[0].startTime) return null;

  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].startTime <= time) lo = mid + 1;
    else hi = mid - 1;
  }
  const index = hi;
  if (index < 0) return null;

  const bar = bars[index];
  const elapsed = time - bar.startTime;
  if (elapsed < 0) return null;
  if (elapsed >= intervalMs) {
    // Allow slight live tail lead on the newest bar before the next bar opens.
    if (index === bars.length - 1 && elapsed <= intervalMs * 1.5) {
      return xOfIndex(index + clamp(elapsed / intervalMs, 0, 1));
    }
    return null;
  }
  return xOfIndex(index + elapsed / intervalMs);
}

export function computeBubbleRadius(
  notionalUsd: number,
  opts: { scaleMode: LiveTradeBubblesScaleMode; sizeScale: number; refMaxNotionalUsd: number },
): number {
  const safeNotional = Math.max(0, Number.isFinite(notionalUsd) ? notionalUsd : 0);
  const scale = clamp(Number.isFinite(opts.sizeScale) ? opts.sizeScale : 1, 0.2, 4);
  const ref = opts.scaleMode === "fixed"
    ? FIXED_REF_NOTIONAL_USD
    : Math.max(1, Number.isFinite(opts.refMaxNotionalUsd) ? opts.refMaxNotionalUsd : 1);
  const norm = Math.sqrt(safeNotional / ref);
  const raw = MIN_BUBBLE_RADIUS_PX + norm * (MAX_BUBBLE_RADIUS_PX - MIN_BUBBLE_RADIUS_PX) * scale;
  return clamp(raw, MIN_BUBBLE_RADIUS_PX, MAX_BUBBLE_RADIUS_PX);
}

export function clusterProjectedBubbles(
  items: readonly ProjectedBubbleInput[],
  cellSizePx = DEFAULT_CLUSTER_CELL_PX,
): ClusteredBubble[] {
  if (!items.length) return [];
  const cell = Math.max(1, cellSizePx);
  const buckets = new Map<string, ClusteredBubble>();

  for (const item of items) {
    const { event, x, y } = item;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const key = `${cx}:${cy}:${event.kind}:${event.side}`;
    const weight = Math.max(0, event.notionalUsd);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        kind: event.kind,
        side: event.side,
        venue: event.venue,
        x,
        y,
        time: event.time,
        price: event.price,
        qty: event.qty,
        notionalUsd: event.notionalUsd,
        count: 1,
        sampled: event.sampled === true,
      });
      continue;
    }
    const prevWeight = Math.max(0, existing.notionalUsd);
    const totalWeight = prevWeight + weight;
    if (totalWeight > 0) {
      existing.x = (existing.x * prevWeight + x * weight) / totalWeight;
      existing.y = (existing.y * prevWeight + y * weight) / totalWeight;
      existing.price = (existing.price * prevWeight + event.price * weight) / totalWeight;
    }
    existing.qty += event.qty;
    existing.notionalUsd += event.notionalUsd;
    existing.count += 1;
    if (event.time > existing.time) existing.time = event.time;
    if (event.sampled === true) existing.sampled = true;
    if (existing.venue !== event.venue && !existing.venue.includes(event.venue)) {
      existing.venue = `${existing.venue}+`;
    }
  }

  return Array.from(buckets.values());
}

export function bubbleColorFor(kind: LiveTradeEventKind, side: LiveTradeEvent["side"]): string {
  if (kind === "liquidation") {
    return side === "short" || side === "buy" ? uiColor.special : uiColor.warn;
  }
  return side === "buy" || side === "long" ? uiColor.buy : uiColor.sell;
}

export function hitTestBubble(
  bubbles: readonly RenderedBubble[],
  x: number,
  y: number,
): RenderedBubble | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best: RenderedBubble | null = null;
  let bestDistSq = Infinity;
  for (const bubble of bubbles) {
    const dx = bubble.x - x;
    const dy = bubble.y - y;
    const hitRadius = Math.max(bubble.radius + 4, 10);
    const distSq = dx * dx + dy * dy;
    if (distSq <= hitRadius * hitRadius && distSq < bestDistSq) {
      best = bubble;
      bestDistSq = distSq;
    }
  }
  return best;
}

function formatEventTime(ms: number): string {
  try {
    return tzDateTimeHud(ms, 60_000);
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

function safeTranslate(key: string, fallback: string): string {
  try {
    return tOr(key);
  } catch {
    return fallback;
  }
}

export function buildBubbleReadout(bubble: RenderedBubble): IndicatorReadout {
  const kindLabel = bubble.kind === "liquidation"
    ? safeTranslate("indicator.liveTradeBubbles.liquidation", "Liquidation")
    : safeTranslate("indicator.liveTradeBubbles.trade", "Trade");
  const sampledNote = bubble.sampled
    ? ` (${safeTranslate("indicator.liveTradeBubbles.sampled", "sampled")})`
    : "";
  const countNote = bubble.count > 1 ? ` ×${bubble.count}` : "";

  return {
    title: `${bubble.venue} · ${kindLabel}${sampledNote}${countNote}`,
    time: formatEventTime(bubble.time),
    items: [
      { label: "Side", value: bubble.side.toUpperCase(), color: bubble.color },
      { label: "Notional", value: compactUsd(bubble.notionalUsd), color: bubble.color },
      { label: "Qty", value: compactNumber(bubble.qty) },
      { label: "Price", value: bubble.price.toFixed(2) },
    ],
  };
}

function unsubscribeInstance(id: string): void {
  const active = activeSubscriptions.get(id);
  if (!active) return;
  activeSubscriptions.delete(id);
  try {
    active.unsubscribe();
  } catch {
    // Host transport may already be disposed.
  }
}

function ensureSubscription(
  ctx: IndicatorDrawContext<LiveTradeBubblesSettings>,
  market: string,
  kinds: LiveTradeEventKind[],
  scope: LiveTradeEventScope,
): "ok" | "unsupported" {
  let source: ReturnType<typeof indicatorDataSource>;
  try {
    source = indicatorDataSource();
  } catch {
    return "unsupported";
  }
  if (typeof source.subscribeLiveTradeEvents !== "function") {
    return "unsupported";
  }

  const key = `${normalizeMarketKey(market)}|${kinds.join(",")}|${scope}`;
  const current = activeSubscriptions.get(ctx.instance.id);
  if (current?.key === key) return "ok";

  unsubscribeInstance(ctx.instance.id);
  const unsubscribe = source.subscribeLiveTradeEvents({
    market,
    kinds,
    scope,
    onEvents: (events) => {
      pushLiveTradeEvents(market, events);
      ctx.requestRefresh();
    },
  });

  activeSubscriptions.set(ctx.instance.id, { key, market, unsubscribe });
  registerIndicatorCleanup(ctx.instance.id, () => unsubscribeInstance(ctx.instance.id));
  return "ok";
}

function prepareLiveTradeBubbles(ctx: IndicatorDrawContext<LiveTradeBubblesSettings>): LiveTradeBubblesPreparedData {
  const market = ctx.chart?.market ?? "";
  const kinds = resolveLiveTradeKinds(ctx.settings.kinds);
  const scope = normalizeScope(ctx.settings.scope);

  if (!ctx.instance.visible || ctx.chart?.asOfTime !== undefined || !market) {
    runIndicatorCleanup(ctx.instance.id);
    return {
      status: ctx.instance.visible ? "no-data" : "hidden",
      points: [],
      meta: { market, scope, kinds, bubbles: [], hovered: null, totalEvents: 0 },
    };
  }

  const subStatus = ensureSubscription(ctx, market, kinds, scope);
  if (subStatus === "unsupported") {
    return {
      status: "unsupported",
      points: [],
      message: safeTranslate("indicator.liveTradeBubbles.unsupported", "Live trade/liquidation stream is not configured"),
      meta: { market, scope, kinds, bubbles: [], hovered: null, totalEvents: 0 },
    };
  }

  const rawEvents = getLiveTradeEvents(market);
  const filtered = filterLiveTradeEvents(rawEvents, {
    kinds: (ctx.settings.kinds as LiveTradeBubblesKindsSetting) ?? "both",
    minTradeNotionalUsd: finiteNonNegative(ctx.settings.minTradeNotionalUsd, 50_000),
    minLiquidationNotionalUsd: finiteNonNegative(ctx.settings.minLiquidationNotionalUsd, 25_000),
  });

  const bars = ctx.series.listReadonly();
  const intervalMs = ctx.chart?.intervalMs ?? ctx.series.config.intervalMs;
  const area = ctx.view.area;
  const projected: ProjectedBubbleInput[] = [];

  for (const event of filtered) {
    const x = eventXInBars(event.time, bars, intervalMs, (idx) => ctx.view.xOfIndex(idx));
    if (x === null || x < area.left - MAX_BUBBLE_RADIUS_PX || x > area.left + area.width + MAX_BUBBLE_RADIUS_PX) {
      continue;
    }
    const y = ctx.view.yOfPrice(event.price);
    if (!Number.isFinite(y) || y < area.top - MAX_BUBBLE_RADIUS_PX || y > area.top + area.height + MAX_BUBBLE_RADIUS_PX) {
      continue;
    }
    projected.push({ event, x, y });
  }

  const clustered = clusterProjectedBubbles(projected, DEFAULT_CLUSTER_CELL_PX);
  const recentSlice = filtered.slice(-RELATIVE_RECENT_WINDOW);
  let refMaxNotionalUsd = 1;
  for (const ev of recentSlice) {
    if (ev.notionalUsd > refMaxNotionalUsd) refMaxNotionalUsd = ev.notionalUsd;
  }
  for (const b of clustered) {
    if (b.notionalUsd > refMaxNotionalUsd) refMaxNotionalUsd = b.notionalUsd;
  }

  const scaleMode = normalizeScaleMode(ctx.settings.scaleMode);
  const sizeScale = clamp(Number(ctx.settings.sizeScale) || 1, 0.2, 4);
  const bubbles: RenderedBubble[] = clustered
    .map((cluster) => ({
      ...cluster,
      radius: computeBubbleRadius(cluster.notionalUsd, { scaleMode, sizeScale, refMaxNotionalUsd }),
      color: bubbleColorFor(cluster.kind, cluster.side),
    }))
    .sort((a, b) => b.radius - a.radius);

  const hovered = ctx.crosshair?.visible
    ? hitTestBubble(bubbles, ctx.crosshair.x, ctx.crosshair.y)
    : null;

  return {
    status: "ok",
    points: [],
    meta: {
      market,
      scope,
      kinds,
      bubbles,
      hovered,
      totalEvents: rawEvents.length,
    },
  };
}

function drawTooltip(
  ctx: IndicatorDrawContext<LiveTradeBubblesSettings>,
  bubble: RenderedBubble,
): void {
  const readout = buildBubbleReadout(bubble);
  const lines = [
    `${readout.title ?? ""} · ${readout.time ?? ""}`,
    ...readout.items.map((item) => `${item.label}: ${item.value ?? ""}`),
  ];

  const canvas = ctx.ctx;
  const area = ctx.view.area;
  canvas.save();
  canvas.font = "11px ui-monospace, monospace";
  const padX = 8;
  const padY = 6;
  const lineH = 15;
  let maxW = 0;
  for (const line of lines) {
    const w = canvas.measureText(line).width;
    if (w > maxW) maxW = w;
  }
  const boxW = Math.ceil(maxW + padX * 2);
  const boxH = lines.length * lineH + padY * 2;
  const rawX = bubble.x + bubble.radius + 10;
  const rawY = bubble.y - boxH / 2;
  const boxX = clamp(rawX + boxW > area.left + area.width ? bubble.x - bubble.radius - 10 - boxW : rawX, area.left + 4, area.left + area.width - boxW - 4);
  const boxY = clamp(rawY, area.top + 4, area.top + area.height - boxH - 4);

  canvas.fillStyle = indicatorBadgeBg;
  canvas.strokeStyle = indicatorBadgeBorder;
  canvas.lineWidth = 1;
  if (typeof canvas.roundRect === "function") {
    canvas.beginPath();
    canvas.roundRect(boxX, boxY, boxW, boxH, 4);
    canvas.fill();
    canvas.stroke();
  } else {
    canvas.fillRect(boxX, boxY, boxW, boxH);
    canvas.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
  }

  canvas.fillStyle = bubble.color;
  canvas.fillRect(boxX + 1, boxY + 4, 2, boxH - 8);

  canvas.fillStyle = indicatorReadoutTextColor;
  canvas.textAlign = "left";
  canvas.textBaseline = "middle";
  for (let i = 0; i < lines.length; i++) {
    canvas.fillText(lines[i], boxX + padX + 2, boxY + padY + lineH * i + lineH / 2);
  }
  canvas.restore();
}

function drawLiveTradeBubbles(
  ctx: IndicatorDrawContext<LiveTradeBubblesSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const data = (prepared ?? prepareLiveTradeBubbles(ctx)) as LiveTradeBubblesPreparedData;
  if (data.status !== "ok" || !data.meta.bubbles.length) return;

  const canvas = ctx.ctx;
  const area = ctx.view.area;
  const opacity = clamp(Number(ctx.settings.opacity) || 0.78, 0.1, 1);
  const showLabels = ctx.settings.showLabels !== false;

  canvas.save();
  canvas.beginPath();
  canvas.rect(area.left, area.top, area.width, area.height);
  canvas.clip();

  canvas.font = "10px ui-monospace, monospace";
  canvas.textAlign = "center";
  canvas.textBaseline = "middle";

  for (const bubble of data.meta.bubbles) {
    canvas.beginPath();
    canvas.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2);

    if (bubble.kind === "liquidation") {
      canvas.globalAlpha = clamp(opacity + 0.12, 0.1, 1);
      canvas.strokeStyle = bubble.color;
      canvas.lineWidth = Math.max(1.5, Math.min(3, bubble.radius * 0.22));
      canvas.stroke();
    } else {
      canvas.globalAlpha = opacity;
      canvas.fillStyle = bubble.color;
      canvas.fill();
      canvas.globalAlpha = clamp(opacity + 0.15, 0.1, 1);
      canvas.strokeStyle = bubble.color;
      canvas.lineWidth = 1;
      canvas.stroke();
    }

    if (showLabels && bubble.radius >= 10) {
      const label = compactUsd(bubble.notionalUsd);
      canvas.globalAlpha = 0.95;
      canvas.lineWidth = 2.5;
      canvas.strokeStyle = indicatorBadgeBg;
      canvas.strokeText(label, bubble.x, bubble.y);
      canvas.fillStyle = indicatorReadoutTextColor;
      canvas.fillText(label, bubble.x, bubble.y);
    }
  }

  if (data.meta.hovered) {
    canvas.globalAlpha = 1;
    drawTooltip(ctx, data.meta.hovered);
  }

  canvas.restore();
}

export const liveTradeBubblesIndicatorDefinition: IndicatorDefinition<LiveTradeBubblesSettings> = {
  type: "live-trade-bubbles",
  name: "Live Trade Bubbles",
  category: "flow",
  defaultPane: "overlay",
  canOverlay: true,
  paneHeight: 96,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  defaultSettings: () => ({
    kinds: "both",
    scope: "base",
    minTradeNotionalUsd: 50_000,
    minLiquidationNotionalUsd: 25_000,
    sizeScale: 1,
    scaleMode: "relative",
    opacity: 0.78,
    showLabels: true,
    showPlotLabel: true,
  }),
  settingsSchema: {
    sections: [{
      title: "Live Trade & Liquidation Bubbles",
      titleKey: "indicator.liveTradeBubbles.section.main",
      fields: [
        {
          kind: "select",
          key: "kinds",
          label: "Events",
          labelKey: "indicator.liveTradeBubbles.kinds",
          description: "Binance liquidations are 1/s sampled; Hyperliquid lacks a public liquidation stream.",
          descriptionKey: "indicator.liveTradeBubbles.kindsDescription",
          options: [
            { label: "Trades + Liquidations", value: "both", labelKey: "indicator.liveTradeBubbles.kinds.both" },
            { label: "Trades Only", value: "trades", labelKey: "indicator.liveTradeBubbles.kinds.trades" },
            { label: "Liquidations Only", value: "liquidations", labelKey: "indicator.liveTradeBubbles.kinds.liquidations" },
          ],
          requiresRecalc: true,
        },
        {
          kind: "select",
          key: "scope",
          label: "Scope",
          labelKey: "indicator.liveTradeBubbles.scope",
          options: [
            { label: "Base (All Venues)", value: "base", labelKey: "indicator.liveTradeBubbles.scope.base" },
            { label: "Chart Market", value: "market", labelKey: "indicator.liveTradeBubbles.scope.market" },
          ],
          requiresRecalc: true,
        },
        {
          kind: "number",
          key: "minTradeNotionalUsd",
          label: "Min Trade ($)",
          labelKey: "indicator.liveTradeBubbles.minTradeNotionalUsd",
          min: 0,
          step: 1000,
        },
        {
          kind: "number",
          key: "minLiquidationNotionalUsd",
          label: "Min Liquidation ($)",
          labelKey: "indicator.liveTradeBubbles.minLiquidationNotionalUsd",
          min: 0,
          step: 1000,
        },
        {
          kind: "select",
          key: "scaleMode",
          label: "Size Scale Mode",
          labelKey: "indicator.liveTradeBubbles.scaleMode",
          options: [
            { label: "Relative (Recent)", value: "relative", labelKey: "indicator.liveTradeBubbles.scaleMode.relative" },
            { label: "Fixed ($1M)", value: "fixed", labelKey: "indicator.liveTradeBubbles.scaleMode.fixed" },
          ],
        },
        {
          kind: "number",
          key: "sizeScale",
          label: "Size Multiplier",
          labelKey: "indicator.liveTradeBubbles.sizeScale",
          min: 0.4,
          max: 2.5,
          step: 0.1,
        },
        {
          kind: "number",
          key: "opacity",
          label: "Opacity",
          labelKey: "indicator.liveTradeBubbles.opacity",
          min: 0.1,
          max: 1,
          step: 0.05,
        },
        {
          kind: "boolean",
          key: "showLabels",
          label: "Show Notional Labels",
          labelKey: "indicator.liveTradeBubbles.showLabels",
        },
        {
          kind: "boolean",
          key: "showPlotLabel",
          label: "Show Header Label",
          labelKey: "indicator.common.showPlotLabel",
        },
      ],
    }],
  },
  getHeaderLabel(ctx) {
    if (ctx.settings.showPlotLabel === false) return "";
    const scope = normalizeScope(ctx.settings.scope);
    const kinds = ctx.settings.kinds === "trades" ? "trades" : ctx.settings.kinds === "liquidations" ? "liqs" : "all";
    return `Live Bubbles · ${kinds} · ${scope}`;
  },
  prepareData: prepareLiveTradeBubbles,
  getReadout(_ctx, prepared) {
    const data = prepared as LiveTradeBubblesPreparedData | undefined;
    const target = data?.meta?.hovered ?? data?.meta?.bubbles?.[0] ?? null;
    return target ? buildBubbleReadout(target) : null;
  },
  drawPriceOverlay: drawLiveTradeBubbles,
};
