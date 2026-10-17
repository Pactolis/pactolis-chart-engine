// A ChartDataSource over a plain JSON `/history` endpoint, so browser tests can serve
// chart data with Playwright routes. It reads the same envelope and wire bars the
// Pactolis gateway answers with, without its streaming transports or retries.
import type { ChartDataSource, RepairHistoryQuery } from "../src/features/chart/chartDataSource.js";
import type { HistoryBatch, HistoryQuery, HistoryStreamSummary, RefreshStatus } from "../src/features/chart/historyContracts.js";
import type { EnvelopeMeta } from "../src/core/envelope.js";
import type { FootprintBar, FootprintCell } from "../src/core/types.js";
import { enforceFootprintPolicy } from "../src/core/footprintPolicy.js";

/** One history bar as the endpoint sends it. Cells are [priceBin, buyVol, sellVol, liqBuy?, liqSell?, count?, buyCount?, sellCount?]. */
export interface WireBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  d: number;
  n?: number;
  lb?: number;
  ls?: number;
  dbs?: number[];
  cells: number[][];
  completeness?: "complete" | "partial" | "provisional";
  updatedAt?: number;
}

interface Envelope {
  ok: boolean;
  data?: { bars?: WireBar[] };
  meta?: EnvelopeMeta;
  error?: { message?: string };
}

function historyParams(q: HistoryQuery): URLSearchParams {
  const params = new URLSearchParams({
    markets: q.markets.join(","),
    from: String(q.from),
    to: String(q.to),
    interval: String(q.interval),
    priceStep: String(q.priceStep),
  });
  if (q.reference) params.set("reference", q.reference);
  if (q.rebuild) params.set("rebuild", "1");
  if (q.includeFootprint === false) params.set("includeFootprint", "0");
  if (q.preferCache) params.set("preferCache", "1");
  if (q.candleCoverage) params.set("candleCoverage", q.candleCoverage);
  if (q.purpose) params.set("purpose", q.purpose);
  if (q.traceId) params.set("trace", q.traceId);
  return params;
}

export function toBar(w: WireBar): FootprintBar {
  const cells = new Map<number, FootprintCell>();
  for (const [priceBin, buyVol, sellVol, liquidationBuyVol, liquidationSellVol, count, buyCount, sellCount] of w.cells ?? []) {
    cells.set(priceBin, { priceBin, buyVol, sellVol, count, buyCount, sellCount, liquidationBuyVol, liquidationSellVol });
  }
  return enforceFootprintPolicy({
    startTime: w.t,
    open: w.o,
    high: w.h,
    low: w.l,
    close: w.c,
    volume: w.v,
    delta: w.d,
    deltaBySize: Array.isArray(w.dbs) ? [...w.dbs] : undefined,
    count: w.n ?? 0,
    liquidationBuyVol: w.lb ?? 0,
    liquidationSellVol: w.ls ?? 0,
    cells,
    hasRef: true,
    completeness: w.completeness ?? "complete",
    sources: ["history"],
    updatedAt: w.updatedAt ?? Date.now(),
  });
}

async function readHistory(params: URLSearchParams, signal: AbortSignal | undefined, onMeta?: (meta: EnvelopeMeta | undefined) => void): Promise<FootprintBar[]> {
  const response = await fetch(`/history?${params.toString()}`, { signal });
  const body = await response.json().catch(() => null) as Envelope | null;
  if (!response.ok || !body?.ok || !body.data) throw new Error(body?.error?.message ?? `history HTTP ${response.status}`);
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  onMeta?.(body.meta);
  return (body.data.bars ?? []).map(toBar);
}

function fetchHistory(q: HistoryQuery): Promise<FootprintBar[]> {
  return readHistory(historyParams(q), q.signal, q.onMeta);
}

async function streamHistory(q: HistoryQuery, onBatch: (batch: HistoryBatch) => void | Promise<void>): Promise<HistoryStreamSummary> {
  let meta: EnvelopeMeta | undefined;
  // `stream=1` lets specs tell streamed loads from one-shot reads.
  const params = historyParams(q);
  params.set("stream", "1");
  const bars = await readHistory(params, q.signal, (m) => { meta = m; q.onMeta?.(m); });
  const cellCount = bars.reduce((sum, bar) => sum + bar.cells.size, 0);
  if (bars.length) await onBatch({ bars, sequence: 0, meta, cellCount });
  return { count: bars.length, cellCount };
}

function fetchRepairHistory(q: RepairHistoryQuery): Promise<FootprintBar[]> {
  const params = new URLSearchParams({
    markets: q.market,
    reference: q.market,
    from: String(q.from),
    to: String(q.to),
    interval: String(q.interval),
    priceStep: String(q.priceStep),
    purpose: "__repair_trade_id_v1",
  });
  return readHistory(params, q.signal, q.onMeta);
}

// `<meta name="footprint-config" content="targetBars=N">`, read once at import like a
// host's runtime config, sets how many bars a chart loads when it opens.
function configuredTargetBars(): number {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="footprint-config"]');
  const value = Number(new URLSearchParams(meta?.content ?? "").get("targetBars"));
  return Number.isFinite(value) && value > 0 ? value : 4000;
}

const sharedLiveOhlc = new Map<string, Promise<FootprintBar[]>>();

export const httpHistorySource: ChartDataSource = {
  streamHistory,
  collectHistory: fetchHistory,
  fetchHistory,
  fetchLiveOhlc: fetchHistory,
  fetchSharedLiveOhlc(q) {
    const key = historyParams(q).toString();
    let pending = sharedLiveOhlc.get(key);
    if (!pending) {
      pending = fetchHistory({ ...q, signal: undefined }).finally(() => sharedLiveOhlc.delete(key));
      sharedLiveOhlc.set(key, pending);
    }
    return pending;
  },
  fetchRepairHistory,
  async startRefresh() {},
  async fetchRefreshStatus(): Promise<RefreshStatus> {
    return { state: "idle", total: 0, done: 0, frac: 0, lastDoneAt: 0 };
  },
  isDirectCandleMarket: () => false,
  initialHistoryBars: configuredTargetBars(),
};
