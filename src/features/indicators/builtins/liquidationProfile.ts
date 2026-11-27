import { tOr } from "../../../core/chartLocaleFallbacks.js";
import { checkSeamAndDetectShift, createLiquidationModel } from "../../../core/analysis/liquidationModel.js";
import { uiColor } from "../../../core/ui/seriesPalette.js";
import { indicatorDataSource } from "../indicatorDataSource.js";
import type {
  LiquidationClusterLevel,
  LiquidationClustersResponse,
  LiquidationClustersState,
  LiquidationClustersStatus,
  LiquidationModelBar,
  LiquidationModelSeriesState,
  LiquidationModelStatus,
} from "../metricContracts.js";
import { compactUsd, drawIndicatorBadge } from "../render/indicatorPaneUi.js";
import type {
  IndicatorDefinition,
  IndicatorDrawContext,
  IndicatorPreparedData,
  IndicatorSettings,
} from "../types.js";
import { boolSetting, numericSetting, stringSetting } from "./taShared.js";

export type LiquidationProfilePlacement = "right" | "left";
export type LiquidationProfileRangePct = 5 | 15 | 30 | 100;
export type LiquidationProfileSource = "auto" | "hyperliquid" | "model";

export interface LiquidationProfileSettings extends IndicatorSettings {
  profilePlacement: LiquidationProfilePlacement;
  profileWidth: number;
  opacity: number;
  rangePct: LiquidationProfileRangePct;
  minNotionalUsd: number;
  showCumulative: boolean;
  longColor: string;
  shortColor: string;
  showReadout: boolean;
  showPlotLabel: boolean;
  source: LiquidationProfileSource;
  showUnverifiedModel: boolean;
}

export interface AlignedLiquidationCluster extends LiquidationClusterLevel {
  hlPrice: number;
  alignedPrice: number;
}

export interface MergedLiquidationRow {
  pixelRow: number;
  y: number;
  hlPrice: number;
  alignedPrice: number;
  longNotional: number;
  shortNotional: number;
  longCount: number;
  shortCount: number;
  totalNotional: number;
}

export interface LiquidationAlignmentWarnings {
  staleMarkPx: boolean;
  priceDivergence: boolean;
  divergencePct: number | null;
}

export type LiquidationModelGateStatus = LiquidationModelStatus | "unverified";

export interface LiquidationProfileMeta extends Record<string, unknown> {
  activeSource: "hyperliquid" | "model";
  responseStatus: LiquidationClustersStatus;
  modelStatus?: LiquidationModelGateStatus;
  modelAsOf?: number | null;
  replayedBars?: number;
  response?: LiquidationClustersResponse;
  binanceLast: number | null;
  hlMarkPx: number | null;
  hlMarkAt: number | null;
  takenAt: number | null;
  clusters: AlignedLiquidationCluster[];
  warnings: LiquidationAlignmentWarnings;
}

export type LiquidationProfilePreparedData = IndicatorPreparedData<never, LiquidationProfileMeta> & {
  meta: LiquidationProfileMeta;
};

const HL_MARK_STALE_MS = 60_000;
const HL_DIVERGENCE_THRESHOLD = 0.01;
const MODEL_STALE_MS = 30 * 86_400_000;

interface PinnedBinanceRefEntry {
  hlMarkPx: number;
  binanceRef: number;
}

/**
 * Pin the Binance/Hyperliquid basis reference once per fetched response object so
 * live Binance price ticks do not shift static Hyperliquid liquidation levels.
 */
const responseBinanceRefCache = new WeakMap<LiquidationClustersResponse, PinnedBinanceRefEntry>();

function resolvePinnedBinanceRef(
  response: LiquidationClustersResponse,
  binanceLast: number | null,
  hlMarkPx: number | null,
): number | null {
  if (hlMarkPx == null || !Number.isFinite(hlMarkPx) || hlMarkPx <= 0) {
    return binanceLast;
  }
  const cached = responseBinanceRefCache.get(response);
  if (cached && cached.hlMarkPx === hlMarkPx) {
    return cached.binanceRef;
  }
  if (binanceLast != null && Number.isFinite(binanceLast) && binanceLast > 0) {
    responseBinanceRefCache.set(response, { hlMarkPx, binanceRef: binanceLast });
    return binanceLast;
  }
  return binanceLast;
}

function safeTranslate(key: string, fallback: string, params?: Record<string, string | number>): string {
  try {
    const resolved = tOr(key, params);
    if (resolved && resolved !== key) return resolved;
  } catch {
    // Unit tests may run without configureChartLocale().
  }
  if (!params) return fallback;
  return fallback.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function alignHlPriceToBinance(
  hlPrice: number,
  binanceLast: number | null | undefined,
  hlMarkPx: number | null | undefined,
): number {
  if (!Number.isFinite(hlPrice)) return hlPrice;
  if (
    binanceLast != null && Number.isFinite(binanceLast) && binanceLast > 0
    && hlMarkPx != null && Number.isFinite(hlMarkPx) && hlMarkPx > 0
  ) {
    return hlPrice * (binanceLast / hlMarkPx);
  }
  return hlPrice;
}

export function computeAlignmentWarnings(
  binanceLast: number | null | undefined,
  hlMarkPx: number | null | undefined,
  hlMarkAt: number | null | undefined,
  nowMs = Date.now(),
): LiquidationAlignmentWarnings {
  const staleMarkPx = hlMarkAt != null && Number.isFinite(hlMarkAt) && (nowMs - hlMarkAt) > HL_MARK_STALE_MS;
  let priceDivergence = false;
  let divergencePct: number | null = null;
  if (
    binanceLast != null && Number.isFinite(binanceLast) && binanceLast > 0
    && hlMarkPx != null && Number.isFinite(hlMarkPx) && hlMarkPx > 0
  ) {
    const ratioDiff = Math.abs(binanceLast / hlMarkPx - 1);
    divergencePct = ratioDiff * 100;
    priceDivergence = ratioDiff > HL_DIVERGENCE_THRESHOLD;
  }
  return { staleMarkPx, priceDivergence, divergencePct };
}

export function filterLiquidationClusters(
  clusters: readonly LiquidationClusterLevel[],
  rangePct: number,
  minNotionalUsd: number,
  referencePrice: number | null | undefined,
): LiquidationClusterLevel[] {
  const applyRange = Number.isFinite(rangePct) && rangePct > 0 && rangePct < 100
    && referencePrice != null && Number.isFinite(referencePrice) && referencePrice > 0;
  const maxRel = applyRange ? rangePct / 100 : Infinity;
  const minNotional = Number.isFinite(minNotionalUsd) && minNotionalUsd > 0 ? minNotionalUsd : 0;

  const filtered: LiquidationClusterLevel[] = [];
  for (const cluster of clusters) {
    if (!Number.isFinite(cluster.price) || cluster.price <= 0) continue;
    const longN = Number.isFinite(cluster.longNotional) && cluster.longNotional > 0 ? cluster.longNotional : 0;
    const shortN = Number.isFinite(cluster.shortNotional) && cluster.shortNotional > 0 ? cluster.shortNotional : 0;
    const total = longN + shortN;
    if (total <= 0 || total < minNotional) continue;
    if (applyRange && Math.abs(cluster.price - referencePrice!) / referencePrice! > maxRel) continue;
    filtered.push({
      price: cluster.price,
      longNotional: longN,
      shortNotional: shortN,
      longCount: Math.max(0, Math.round(cluster.longCount || 0)),
      shortCount: Math.max(0, Math.round(cluster.shortCount || 0)),
    });
  }
  return filtered;
}

export function mergeClustersByPixelRow(
  clusters: readonly AlignedLiquidationCluster[],
  yOfPrice: (price: number) => number,
  areaTop: number,
  areaBottom: number,
): MergedLiquidationRow[] {
  const byRow = new Map<number, {
    pixelRow: number;
    longNotional: number;
    shortNotional: number;
    longCount: number;
    shortCount: number;
    weightedHlPrice: number;
    weightedAlignedPrice: number;
    totalNotional: number;
  }>();

  for (const cluster of clusters) {
    const y = yOfPrice(cluster.alignedPrice);
    if (!Number.isFinite(y) || y < areaTop - 2 || y > areaBottom + 2) continue;
    const pixelRow = Math.floor(y);
    const total = cluster.longNotional + cluster.shortNotional;
    if (total <= 0) continue;

    let entry = byRow.get(pixelRow);
    if (!entry) {
      entry = {
        pixelRow,
        longNotional: 0,
        shortNotional: 0,
        longCount: 0,
        shortCount: 0,
        weightedHlPrice: 0,
        weightedAlignedPrice: 0,
        totalNotional: 0,
      };
      byRow.set(pixelRow, entry);
    }
    entry.longNotional += cluster.longNotional;
    entry.shortNotional += cluster.shortNotional;
    entry.longCount += cluster.longCount;
    entry.shortCount += cluster.shortCount;
    entry.weightedHlPrice += cluster.hlPrice * total;
    entry.weightedAlignedPrice += cluster.alignedPrice * total;
    entry.totalNotional += total;
  }

  const rows: MergedLiquidationRow[] = [];
  for (const entry of byRow.values()) {
    const denom = entry.totalNotional > 0 ? entry.totalNotional : 1;
    rows.push({
      pixelRow: entry.pixelRow,
      y: entry.pixelRow + 0.5,
      hlPrice: entry.weightedHlPrice / denom,
      alignedPrice: entry.weightedAlignedPrice / denom,
      longNotional: entry.longNotional,
      shortNotional: entry.shortNotional,
      longCount: entry.longCount,
      shortCount: entry.shortCount,
      totalNotional: entry.totalNotional,
    });
  }
  rows.sort((a, b) => a.pixelRow - b.pixelRow);
  return rows;
}

export function buildLiquidationProfileStatusText(
  responseStatus: LiquidationClustersStatus,
  takenAt: number | null | undefined,
  nowMs = Date.now(),
): string {
  if (responseStatus === "unsupported") {
    return safeTranslate("indicator.liquidationProfile.unsupported", "Hyperliquid'de bu market yok");
  }
  if (responseStatus === "disabled" || responseStatus === "unavailable") {
    return safeTranslate("indicator.liquidationProfile.unavailable", "Likidasyon verisi yok");
  }
  if (takenAt != null && Number.isFinite(takenAt)) {
    const minutes = Math.max(0, Math.round((nowMs - takenAt) / 60_000));
    if (minutes <= 0) {
      return safeTranslate("indicator.liquidationProfile.badgeNow", "Hyperliquid · şimdi · tahmini");
    }
    return safeTranslate(
      "indicator.liquidationProfile.badge",
      `Hyperliquid · snapshot ${minutes} dk önce · tahmini`,
      { minutes },
    );
  }
  return safeTranslate("indicator.liquidationProfile.badgeNow", "Hyperliquid · şimdi · tahmini");
}

export function buildLiquidationModelStatusText(modelStatus: LiquidationModelGateStatus): string {
  switch (modelStatus) {
    case "ready":
      return safeTranslate("indicator.liquidationProfile.badgeModelSource", "Model · tahmini · Binance");
    case "warming":
      return safeTranslate("indicator.liquidationProfile.warming", "Model ısınıyor");
    case "stale":
      return safeTranslate("indicator.liquidationProfile.modelStale", "Model verisi eski (>30 gün)");
    case "seam-mismatch":
      return safeTranslate("indicator.liquidationProfile.seamMismatch", "Model seam uyuşmazlığı");
    case "unverified":
      return safeTranslate("indicator.liquidationProfile.modelUnverified", "Model bu paritede doğrulanmadı");
    case "unsupported":
      return safeTranslate("indicator.liquidationProfile.modelUnsupported", "Bu market desteklenmiyor");
    case "unavailable":
    default:
      return safeTranslate("indicator.liquidationProfile.unavailable", "Likidasyon verisi yok");
  }
}

function emptyPrepared(
  status: IndicatorPreparedData["status"],
  responseStatus: LiquidationClustersStatus,
  message: string,
  binanceLast: number | null = null,
  activeSource: "hyperliquid" | "model" = "hyperliquid",
  modelStatus?: LiquidationModelGateStatus,
): LiquidationProfilePreparedData {
  return {
    status,
    points: [],
    meta: {
      activeSource,
      responseStatus,
      ...(modelStatus ? { modelStatus } : {}),
      binanceLast,
      hlMarkPx: null,
      hlMarkAt: null,
      takenAt: null,
      clusters: [],
      warnings: { staleMarkPx: false, priceDivergence: false, divergencePct: null },
    },
    message,
  };
}

function queryClustersState(
  market: string,
  rangePct: number,
  source: LiquidationProfileSource | undefined,
  onUpdate: () => void,
): LiquidationClustersState {
  try {
    const ds = indicatorDataSource();
    if (typeof ds.requestLiquidationClusters !== "function") {
      return { status: "unavailable" };
    }
    return ds.requestLiquidationClusters({
      market,
      rangePct,
      ...(source ? { source } : {}),
      onUpdate,
    });
  } catch {
    return { status: "unavailable" };
  }
}

function hasModelProvider(): boolean {
  try {
    const ds = indicatorDataSource();
    return typeof ds.requestLiquidationModel === "function";
  } catch {
    return false;
  }
}

function queryModelState(market: string, onUpdate: () => void): LiquidationModelSeriesState {
  try {
    const ds = indicatorDataSource();
    if (typeof ds.requestLiquidationModel !== "function") {
      return { status: "unavailable" };
    }
    return ds.requestLiquidationModel({ market, onUpdate });
  } catch {
    return { status: "unavailable" };
  }
}

function prepareModelProfile(
  market: string,
  rangePct: number,
  minNotionalUsd: number,
  binanceLast: number | null,
  showUnverifiedModel: boolean,
  onUpdate: () => void,
  nowMs = Date.now(),
): LiquidationProfilePreparedData {
  const state = queryModelState(market, onUpdate);
  if (state.status === "idle" || state.status === "loading") {
    return emptyPrepared("loading", "unavailable", "loading", binanceLast, "model");
  }
  if (state.status === "error") {
    return emptyPrepared(
      "error",
      "unavailable",
      state.message || buildLiquidationModelStatusText("unavailable"),
      binanceLast,
      "model",
      "unavailable",
    );
  }
  if (
    state.status === "warming"
    || state.status === "unsupported"
    || state.status === "stale"
    || state.status === "seam-mismatch"
    || state.status === "unavailable"
  ) {
    const prepStatus: IndicatorPreparedData["status"] = state.status === "unsupported" ? "unsupported" : "no-data";
    return emptyPrepared(
      prepStatus,
      state.status === "unsupported" ? "unsupported" : "unavailable",
      state.message ?? buildLiquidationModelStatusText(state.status),
      binanceLast,
      "model",
      state.status,
    );
  }

  const response = state.data;
  if (response.status !== "ready" || !response.state) {
    const ms: LiquidationModelGateStatus = response.status === "ready" ? "unavailable" : response.status;
    return emptyPrepared(
      ms === "unsupported" ? "unsupported" : "no-data",
      ms === "unsupported" ? "unsupported" : "unavailable",
      buildLiquidationModelStatusText(ms),
      binanceLast,
      "model",
      ms,
    );
  }

  const modelState = response.state;
  if (Number.isFinite(modelState.asOf) && nowMs - modelState.asOf > MODEL_STALE_MS) {
    return emptyPrepared("no-data", "stale", buildLiquidationModelStatusText("stale"), binanceLast, "model", "stale");
  }

  if (modelState.v1?.passed !== true && !showUnverifiedModel) {
    return emptyPrepared(
      "no-data",
      "unavailable",
      buildLiquidationModelStatusText("unverified"),
      binanceLast,
      "model",
      "unverified",
    );
  }

  let replayBars: LiquidationModelBar[] = Array.isArray(response.bars) ? response.bars : [];
  if (replayBars.length > 0 && Array.isArray(modelState.seam) && modelState.seam.length > 0) {
    const seamCheck = checkSeamAndDetectShift(modelState.seam, replayBars);
    if (seamCheck.status === "seam-mismatch") {
      return emptyPrepared(
        "no-data",
        "unavailable",
        buildLiquidationModelStatusText("seam-mismatch"),
        binanceLast,
        "model",
        "seam-mismatch",
      );
    }
    replayBars = seamCheck.correctedBars;
  }

  const sim = createLiquidationModel(modelState);
  let replayedBars = 0;
  for (const bar of replayBars) {
    if (bar.t > modelState.asOf) {
      sim.step(bar);
      replayedBars += 1;
    }
  }

  const book = sim.book();
  const rawClusters: LiquidationClusterLevel[] = [];
  for (let i = 0; i < book.centers.length; i += 1) {
    const longNotional = book.longUsd[i] ?? 0;
    const shortNotional = book.shortUsd[i] ?? 0;
    if (longNotional > 0 || shortNotional > 0) {
      rawClusters.push({
        price: book.centers[i],
        longNotional,
        shortNotional,
        longCount: 0,
        shortCount: 0,
      });
    }
  }

  const refPrice = binanceLast ?? (sim.lastClose > 0 ? sim.lastClose : null);
  const filtered = filterLiquidationClusters(rawClusters, rangePct, minNotionalUsd, refPrice);
  const aligned: AlignedLiquidationCluster[] = filtered.map((cluster) => ({
    ...cluster,
    hlPrice: cluster.price,
    alignedPrice: cluster.price,
  }));
  aligned.sort((a, b) => a.alignedPrice - b.alignedPrice);

  return {
    status: aligned.length > 0 ? "ok" : "no-data",
    points: [],
    meta: {
      activeSource: "model",
      responseStatus: "ready",
      modelStatus: "ready",
      modelAsOf: modelState.asOf,
      replayedBars,
      binanceLast,
      hlMarkPx: null,
      hlMarkAt: null,
      takenAt: modelState.asOf,
      clusters: aligned,
      warnings: { staleMarkPx: false, priceDivergence: false, divergencePct: null },
    },
    message: buildLiquidationModelStatusText("ready"),
  };
}

export function prepareLiquidationProfile(
  ctx: IndicatorDrawContext<LiquidationProfileSettings>,
): LiquidationProfilePreparedData {
  if (!ctx.instance.visible) {
    return emptyPrepared("hidden", "unavailable", "hidden");
  }
  const all = ctx.series.listReadonly();
  const lastBar = all[all.length - 1];
  const binanceLast = lastBar && Number.isFinite(lastBar.close) && lastBar.close > 0 ? lastBar.close : null;

  if (ctx.chart?.asOfTime !== undefined) {
    return emptyPrepared("no-data", "unavailable", buildLiquidationProfileStatusText("unavailable", null), binanceLast);
  }

  const rangePct = numericSetting(ctx.settings, "rangePct", 15, 5, 100);
  const minNotionalUsd = numericSetting(ctx.settings, "minNotionalUsd", 0, 0, 1_000_000_000);
  const market = ctx.chart?.market ?? "";
  const source: LiquidationProfileSource =
    ctx.settings.source === "hyperliquid" || ctx.settings.source === "model" ? ctx.settings.source : "auto";
  const showUnverifiedModel = boolSetting(ctx.settings, "showUnverifiedModel", false);

  if (source === "model") {
    return prepareModelProfile(market, rangePct, minNotionalUsd, binanceLast, showUnverifiedModel, ctx.requestRefresh);
  }

  const state = queryClustersState(market, rangePct, source, ctx.requestRefresh);
  if (state.status === "idle" || state.status === "loading") {
    return emptyPrepared("loading", "unavailable", "loading", binanceLast);
  }

  const hlUnavailable =
    state.status === "error"
    || state.status === "unsupported"
    || state.status === "disabled"
    || state.status === "unavailable"
    || (state.status === "ready"
      && (state.data.status === "unsupported" || state.data.status === "disabled" || state.data.status === "unavailable"));

  if (source === "auto" && hlUnavailable && hasModelProvider()) {
    return prepareModelProfile(market, rangePct, minNotionalUsd, binanceLast, showUnverifiedModel, ctx.requestRefresh);
  }

  if (state.status === "error") {
    return emptyPrepared("error", "unavailable", state.message || buildLiquidationProfileStatusText("unavailable", null), binanceLast);
  }
  if (state.status === "unsupported") {
    return emptyPrepared("unsupported", "unsupported", state.message ?? buildLiquidationProfileStatusText("unsupported", null), binanceLast);
  }
  if (state.status === "disabled" || state.status === "unavailable") {
    return emptyPrepared("no-data", state.status, state.message ?? buildLiquidationProfileStatusText(state.status, null), binanceLast);
  }

  const response = state.data;
  const responseStatus: LiquidationClustersStatus = response.stale && response.status === "ready"
    ? "stale"
    : response.status;

  if (responseStatus === "unsupported") {
    return emptyPrepared("unsupported", "unsupported", buildLiquidationProfileStatusText("unsupported", null), binanceLast);
  }
  if (responseStatus === "disabled" || responseStatus === "unavailable") {
    return emptyPrepared("no-data", responseStatus, buildLiquidationProfileStatusText(responseStatus, null), binanceLast);
  }

  const hlMarkPx = response.hlMarkPx ?? null;
  const hlMarkAt = response.hlMarkAt ?? null;
  const takenAt = response.takenAt ?? response.fetchedAt ?? null;
  const pinnedBinanceRef = resolvePinnedBinanceRef(response, binanceLast, hlMarkPx);
  const refPrice = hlMarkPx && hlMarkPx > 0 ? hlMarkPx : pinnedBinanceRef;
  const filtered = filterLiquidationClusters(response.clusters ?? [], rangePct, minNotionalUsd, refPrice);
  const aligned: AlignedLiquidationCluster[] = filtered.map((cluster) => ({
    ...cluster,
    hlPrice: cluster.price,
    alignedPrice: alignHlPriceToBinance(cluster.price, pinnedBinanceRef, hlMarkPx),
  }));
  aligned.sort((a, b) => a.alignedPrice - b.alignedPrice);

  const warnings = computeAlignmentWarnings(pinnedBinanceRef, hlMarkPx, hlMarkAt);
  const message = buildLiquidationProfileStatusText(responseStatus, takenAt);

  return {
    status: aligned.length > 0 ? "ok" : "no-data",
    points: [],
    meta: {
      activeSource: "hyperliquid",
      responseStatus,
      response,
      binanceLast,
      hlMarkPx,
      hlMarkAt,
      takenAt,
      clusters: aligned,
      warnings,
    },
    message,
  };
}

function asLiquidationProfileData(prepared?: IndicatorPreparedData): LiquidationProfilePreparedData {
  if (prepared?.meta && "responseStatus" in prepared.meta) {
    return prepared as LiquidationProfilePreparedData;
  }
  return emptyPrepared("no-data", "unavailable", buildLiquidationProfileStatusText("unavailable", null));
}

function formatAlignedPrice(price: number): string {
  if (!Number.isFinite(price)) return "—";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

function formatModelAsOf(asOfMs: number): string {
  if (!Number.isFinite(asOfMs)) return "—";
  const d = new Date(asOfMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}

function drawCumulativeCurves(
  canvas: CanvasRenderingContext2D,
  rows: readonly MergedLiquidationRow[],
  clusters: readonly AlignedLiquidationCluster[],
  binanceLast: number | null,
  anchorX: number,
  maxWidth: number,
  placement: LiquidationProfilePlacement,
  longColor: string,
  shortColor: string,
  yOfPrice: (price: number) => number,
  areaTop: number,
  areaBottom: number,
  dashed = false,
): void {
  if (rows.length === 0 && clusters.length === 0) return;
  const pivot = binanceLast ?? (clusters[Math.floor(clusters.length / 2)]?.alignedPrice ?? 0);

  // Accumulate shorts upward from pivot and longs downward from pivot.
  const longPoints: Array<{ y: number; cum: number }> = [];
  const shortPoints: Array<{ y: number; cum: number }> = [];

  let longCum = 0;
  for (let i = clusters.length - 1; i >= 0; i -= 1) {
    const c = clusters[i];
    if (c.alignedPrice > pivot && c.longNotional <= 0) continue;
    if (c.longNotional <= 0) continue;
    longCum += c.longNotional;
    const y = yOfPrice(c.alignedPrice);
    if (y >= areaTop - 2 && y <= areaBottom + 2) {
      longPoints.push({ y, cum: longCum });
    }
  }

  let shortCum = 0;
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    if (c.alignedPrice < pivot && c.shortNotional <= 0) continue;
    if (c.shortNotional <= 0) continue;
    shortCum += c.shortNotional;
    const y = yOfPrice(c.alignedPrice);
    if (y >= areaTop - 2 && y <= areaBottom + 2) {
      shortPoints.push({ y, cum: shortCum });
    }
  }

  const maxCum = Math.max(longCum, shortCum, Number.EPSILON);
  const drawCurve = (pts: Array<{ y: number; cum: number }>, color: string) => {
    if (pts.length < 2) return;
    canvas.strokeStyle = color;
    canvas.lineWidth = 1.5;
    if (dashed && typeof canvas.setLineDash === "function") {
      canvas.setLineDash([4, 3]);
    }
    canvas.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const offset = maxWidth * (pts[i].cum / maxCum);
      const x = placement === "left" ? anchorX + offset : anchorX - offset;
      if (i === 0) canvas.moveTo(x, pts[i].y);
      else canvas.lineTo(x, pts[i].y);
    }
    canvas.stroke();
    if (dashed && typeof canvas.setLineDash === "function") {
      canvas.setLineDash([]);
    }
  };

  drawCurve(longPoints, longColor);
  drawCurve(shortPoints, shortColor);
}

export function drawLiquidationProfileOverlay(
  ctx: IndicatorDrawContext<LiquidationProfileSettings>,
  prepared?: IndicatorPreparedData,
): void {
  const data = asLiquidationProfileData(prepared ?? prepareLiquidationProfile(ctx));
  const { view, ctx: canvas, settings } = ctx;
  const {
    activeSource = "hyperliquid",
    responseStatus,
    modelStatus,
    modelAsOf,
    replayedBars,
    clusters,
    warnings,
    takenAt,
    binanceLast,
  } = data.meta;
  const placement: LiquidationProfilePlacement = settings.profilePlacement === "left" ? "left" : "right";
  const showPlotLabel = settings.showPlotLabel !== false;
  const areaTop = view.area.top;
  const areaBottom = view.area.top + view.area.height;
  const badgeX = placement === "left" ? view.area.left + 8 : view.area.left + view.area.width - 8;
  const badgeMaxW = Math.max(180, Math.min(360, view.area.width - 16));

  if (activeSource === "model" && modelStatus !== "ready") {
    if (showPlotLabel && data.status !== "hidden" && data.status !== "loading") {
      const statusKey = modelStatus ?? "unavailable";
      const isWarn = statusKey === "stale" || statusKey === "seam-mismatch" || statusKey === "unverified" || statusKey === "unsupported";
      drawIndicatorBadge(
        canvas,
        buildLiquidationModelStatusText(statusKey),
        badgeX,
        areaTop + 18,
        {
          color: isWarn ? uiColor.warn : uiColor.textSecondary,
          align: placement,
          maxWidth: badgeMaxW,
        },
      );
    }
    return;
  }

  if (activeSource === "hyperliquid" && (responseStatus === "unsupported" || responseStatus === "disabled" || responseStatus === "unavailable")) {
    if (showPlotLabel && data.status !== "hidden" && data.status !== "loading") {
      drawIndicatorBadge(
        canvas,
        buildLiquidationProfileStatusText(responseStatus, null),
        badgeX,
        areaTop + 18,
        {
          color: responseStatus === "unsupported" ? uiColor.warn : uiColor.textSecondary,
          align: placement,
          maxWidth: badgeMaxW,
        },
      );
    }
    return;
  }

  const maxWidth = Math.min(view.area.width * 0.34, numericSetting(settings, "profileWidth", 180, 40, 500));
  const opacity = numericSetting(settings, "opacity", 0.72, 0.1, 1);
  const drawAlpha = activeSource === "model" ? Math.max(0.08, opacity * 0.55) : opacity;
  const anchorX = placement === "left" ? view.area.left + 4 : view.area.left + view.area.width - 4;
  const longColor = stringSetting(settings, "longColor", uiColor.buy);
  const shortColor = stringSetting(settings, "shortColor", uiColor.sell);

  const rows = mergeClustersByPixelRow(clusters, (p) => view.yOfPrice(p), areaTop, areaBottom);
  let maxRowTotal = 0;
  for (const row of rows) {
    if (row.totalNotional > maxRowTotal) maxRowTotal = row.totalNotional;
  }
  const normDenom = Math.max(maxRowTotal, Number.EPSILON);

  canvas.save();
  canvas.beginPath();
  canvas.rect(view.area.left, areaTop, view.area.width, view.area.height);
  canvas.clip();

  canvas.globalAlpha = drawAlpha;
  for (const row of rows) {
    const longW = maxWidth * (row.longNotional / normDenom);
    const shortW = maxWidth * (row.shortNotional / normDenom);
    let cursor = anchorX;
    if (placement === "left") {
      if (longW > 0) {
        canvas.fillStyle = longColor;
        canvas.fillRect(cursor, row.pixelRow, longW, 1);
        cursor += longW;
      }
      if (shortW > 0) {
        canvas.fillStyle = shortColor;
        canvas.fillRect(cursor, row.pixelRow, shortW, 1);
      }
    } else {
      if (longW > 0) {
        canvas.fillStyle = longColor;
        canvas.fillRect(cursor - longW, row.pixelRow, longW, 1);
        cursor -= longW;
      }
      if (shortW > 0) {
        canvas.fillStyle = shortColor;
        canvas.fillRect(cursor - shortW, row.pixelRow, shortW, 1);
      }
    }
  }

  if (boolSetting(settings, "showCumulative", false)) {
    canvas.globalAlpha = Math.min(1, drawAlpha + 0.15);
    drawCumulativeCurves(
      canvas,
      rows,
      clusters,
      binanceLast,
      anchorX,
      maxWidth,
      placement,
      longColor,
      shortColor,
      (p) => view.yOfPrice(p),
      areaTop,
      areaBottom,
      activeSource === "model",
    );
  }
  canvas.globalAlpha = 1;
  canvas.restore();

  let nextBadgeY = areaTop + 18;
  if (showPlotLabel) {
    if (activeSource === "model") {
      drawIndicatorBadge(
        canvas,
        safeTranslate("indicator.liquidationProfile.badgeModelSource", "Model · tahmini · Binance"),
        badgeX,
        nextBadgeY,
        {
          color: uiColor.info,
          align: placement,
          maxWidth: badgeMaxW,
        },
      );
      nextBadgeY += 24;
    } else {
      drawIndicatorBadge(
        canvas,
        safeTranslate("indicator.liquidationProfile.badgeHyperliquidSource", "Hyperliquid · gerçek pozisyon"),
        badgeX,
        nextBadgeY,
        {
          color: uiColor.info,
          align: placement,
          maxWidth: badgeMaxW,
        },
      );
      nextBadgeY += 24;

      const isWarn = responseStatus === "stale" || responseStatus === "source-changed";
      drawIndicatorBadge(
        canvas,
        buildLiquidationProfileStatusText(responseStatus, takenAt),
        badgeX,
        nextBadgeY,
        {
          color: isWarn ? uiColor.warn : uiColor.info,
          align: placement,
          maxWidth: badgeMaxW,
        },
      );
      nextBadgeY += 24;

      if (warnings.staleMarkPx) {
        drawIndicatorBadge(
          canvas,
          safeTranslate("indicator.liquidationProfile.hlPriceStale", "HL fiyatı eski"),
          badgeX,
          nextBadgeY,
          { color: uiColor.warn, align: placement, maxWidth: badgeMaxW },
        );
        nextBadgeY += 24;
      }
      if (warnings.priceDivergence) {
        drawIndicatorBadge(
          canvas,
          safeTranslate("indicator.liquidationProfile.priceDivergence", "HL/Binance fiyat farkı >%1"),
          badgeX,
          nextBadgeY,
          { color: uiColor.warn, align: placement, maxWidth: badgeMaxW },
        );
        nextBadgeY += 24;
      }
    }
  }

  if (settings.showReadout !== false && ctx.crosshair?.visible && rows.length > 0) {
    const cy = ctx.crosshair.y;
    if (cy >= areaTop && cy <= areaBottom) {
      let best: MergedLiquidationRow | null = null;
      let bestDist = 6;
      for (const row of rows) {
        const dist = Math.abs(row.y - cy);
        if (dist <= bestDist) {
          bestDist = dist;
          best = row;
        }
      }
      if (best) {
        const parts: string[] = [];
        if (activeSource === "model") {
          parts.push(`Seviye ${formatAlignedPrice(best.alignedPrice)}`);
          if (best.longNotional > 0) parts.push(`L ~${compactUsd(best.longNotional)}`);
          if (best.shortNotional > 0) parts.push(`S ~${compactUsd(best.shortNotional)}`);
          if (modelAsOf != null) parts.push(`asOf ${formatModelAsOf(modelAsOf)}`);
          parts.push(`+${replayedBars ?? 0} bar`);
        } else {
          if (best.longNotional > 0) parts.push(`L ${compactUsd(best.longNotional)} (${best.longCount})`);
          if (best.shortNotional > 0) parts.push(`S ${compactUsd(best.shortNotional)} (${best.shortCount})`);
          parts.push(`HL ${formatAlignedPrice(best.hlPrice)} → Binance ≈ ${formatAlignedPrice(best.alignedPrice)}`);
        }
        drawIndicatorBadge(
          canvas,
          parts.join(" · "),
          badgeX,
          nextBadgeY,
          {
            color: uiColor.textHeading,
            align: placement,
            maxWidth: Math.max(260, Math.min(520, view.area.width - 16)),
          },
        );
      }
    }
  }
}

function headerLabel(ctx: {
  settings: LiquidationProfileSettings;
  chart?: { market: string };
  prepared?: IndicatorPreparedData;
}): string {
  if (ctx.settings.showPlotLabel === false) return "";
  const data = ctx.prepared as LiquidationProfilePreparedData | undefined;
  const rangePct = numericSetting(ctx.settings, "rangePct", 15, 5, 100);
  const rangeText = rangePct >= 100
    ? safeTranslate("indicator.liquidationProfile.rangeAll", "Tümü")
    : `%${rangePct}`;
  const densityNote = safeTranslate("indicator.liquidationProfile.densityNote", "bekleyen tahmini likidasyon yoğunluğu");
  const activeSource = data?.meta?.activeSource ?? "hyperliquid";
  const sourceLabel = activeSource === "model" ? "Model (Binance)" : "Hyperliquid";
  const status = activeSource === "model" ? data?.meta?.modelStatus : data?.meta?.responseStatus;
  const statusTag = status && status !== "ready" ? ` · ${status}` : "";
  return `Liquidation Profile · ${sourceLabel} · ${rangeText} · ${densityNote}${statusTag}`;
}

export const liquidationProfileIndicatorDefinition: IndicatorDefinition<LiquidationProfileSettings> = {
  type: "liquidation-profile",
  name: "Liquidation Profile",
  category: "derivatives",
  defaultPane: "overlay",
  canOverlay: true,
  paneHeight: 96,
  defaultPlacement: "price-overlay",
  supportedPlacements: ["price-overlay"],
  defaultSettings: () => ({
    profilePlacement: "right",
    profileWidth: 180,
    opacity: 0.72,
    rangePct: 15,
    minNotionalUsd: 0,
    showCumulative: false,
    longColor: uiColor.buy,
    shortColor: uiColor.sell,
    showReadout: true,
    showPlotLabel: true,
    source: "auto",
    showUnverifiedModel: false,
  }),
  settingsSchema: {
    sections: [
      {
        title: "Calculation",
        titleKey: "indicator.common.section.calculation",
        fields: [
          {
            kind: "select",
            key: "source",
            label: "Source",
            labelKey: "indicator.liquidationProfile.source",
            options: [
              { label: "Auto", value: "auto", labelKey: "indicator.liquidationProfile.source.auto" },
              { label: "Hyperliquid", value: "hyperliquid", labelKey: "indicator.liquidationProfile.source.hyperliquid" },
              { label: "Model (Binance)", value: "model", labelKey: "indicator.liquidationProfile.source.model" },
            ],
            requiresRecalc: true,
          },
          {
            kind: "boolean",
            key: "showUnverifiedModel",
            label: "Show unverified model anyway",
            labelKey: "indicator.liquidationProfile.showUnverifiedModel",
            requiresRecalc: true,
          },
          {
            kind: "select",
            key: "rangePct",
            label: "Price Range",
            labelKey: "indicator.liquidationProfile.rangePct",
            options: [
              { label: "%5", value: 5 },
              { label: "%15", value: 15 },
              { label: "%30", value: 30 },
              { label: "All", value: 100, labelKey: "indicator.liquidationProfile.rangeAll" },
            ],
            requiresRecalc: true,
          },
          {
            kind: "number",
            key: "minNotionalUsd",
            label: "Min Notional (USD)",
            labelKey: "indicator.liquidationProfile.minNotionalUsd",
            min: 0,
            max: 100_000_000,
            step: 10_000,
            requiresRecalc: true,
          },
        ],
      },
      {
        title: "Style",
        titleKey: "indicator.common.section.style",
        fields: [
          {
            kind: "select",
            key: "profilePlacement",
            label: "Placement",
            labelKey: "indicator.volumeProfile.placement",
            options: [
              { label: "Right", value: "right", labelKey: "indicator.volumeProfile.placement.right" },
              { label: "Left", value: "left", labelKey: "indicator.volumeProfile.placement.left" },
            ],
          },
          {
            kind: "number",
            key: "profileWidth",
            label: "Width",
            labelKey: "indicator.liquidationProfile.profileWidth",
            min: 40,
            max: 500,
            step: 5,
          },
          {
            kind: "number",
            key: "opacity",
            label: "Opacity",
            labelKey: "indicator.liquidationProfile.opacity",
            min: 0.1,
            max: 1,
            step: 0.01,
          },
          {
            kind: "boolean",
            key: "showCumulative",
            label: "Cumulative Curve",
            labelKey: "indicator.liquidationProfile.showCumulative",
          },
          {
            kind: "color",
            key: "longColor",
            label: "Long Liquidation Color",
            labelKey: "indicator.liquidationProfile.longColor",
          },
          {
            kind: "color",
            key: "shortColor",
            label: "Short Liquidation Color",
            labelKey: "indicator.liquidationProfile.shortColor",
          },
          {
            kind: "boolean",
            key: "showReadout",
            label: "Show Readout",
            labelKey: "indicator.common.showReadout",
          },
          {
            kind: "boolean",
            key: "showPlotLabel",
            label: "Show Header Label",
            labelKey: "indicator.common.showPlotLabel",
          },
        ],
      },
    ],
  },
  getHeaderLabel: headerLabel,
  prepareData: prepareLiquidationProfile,
  drawPriceOverlay: drawLiquidationProfileOverlay,
};
