// @ts-check
// A stand-in for the host's ChartDataSource port. Tests supply the parsed bars and
// envelope meta a read answers with; the fake records every query it receives, so a
// test can assert on what the chart asked for instead of on request URLs.
import { configureChartDataSource } from "../../dist/features/chart/chartDataSource.js";

/**
 * @typedef {import("../../dist/core/types.js").FootprintBar} FootprintBar
 * @typedef {import("../../dist/core/envelope.js").EnvelopeMeta} EnvelopeMeta
 * @typedef {"stream" | "collect" | "fetch" | "liveOhlc" | "sharedLiveOhlc" | "repair" | "startRefresh" | "refreshStatus"} CallKind
 * @typedef {{ kind: CallKind } & Record<string, any>} RecordedQuery
 * @typedef {{ bars?: FootprintBar[], batches?: FootprintBar[][], meta?: EnvelopeMeta }} ReadAnswer
 * @typedef {(query: RecordedQuery) => ReadAnswer | FootprintBar[] | undefined | Promise<ReadAnswer | FootprintBar[] | undefined>} ReadHandler
 */

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

/** @param {ReadAnswer | FootprintBar[] | undefined} answer */
function normalize(answer) {
  if (Array.isArray(answer)) return { batches: [answer], meta: undefined };
  const batches = answer?.batches ?? [answer?.bars ?? []];
  return { batches, meta: answer?.meta };
}

/** @param {FootprintBar[]} bars */
function cellCounts(bars) {
  return bars.map((bar) => bar.cells.size);
}

/**
 * @param {{
 *   history?: ReadHandler,
 *   liveOhlc?: ReadHandler,
 *   repair?: ReadHandler,
 *   startRefresh?: (request: Record<string, any>) => void | Promise<void>,
 *   refreshStatus?: () => any,
 *   directCandleMarkets?: string[],
 *   initialHistoryBars?: number,
 * }} [options]
 *   `history` answers stream, collect and one-shot history reads; `liveOhlc` and
 *   `repair` default to it. A handler returns bars, `{ bars, meta }`, or
 *   `{ batches, meta }` for a stream delivered in several batches; it throws to fail
 *   the read.
 */
export function createFakeChartDataSource(options = {}) {
  const history = options.history ?? (() => []);
  const liveOhlc = options.liveOhlc ?? history;
  const repair = options.repair ?? history;
  const directCandleMarkets = new Set(options.directCandleMarkets ?? []);
  /** @type {RecordedQuery[]} */
  const queries = [];

  /** @param {CallKind} kind @param {Record<string, any>} query @param {ReadHandler} handler */
  async function read(kind, query, handler) {
    const recorded = { kind, ...query };
    queries.push(recorded);
    if (query.signal?.aborted) throw query.signal.reason ?? abortError();
    const answer = normalize(await handler(recorded));
    if (query.signal?.aborted) throw abortError();
    return answer;
  }

  /** @param {CallKind} kind @param {Record<string, any>} query @param {(batch: any) => void | Promise<void>} onBatch */
  async function stream(kind, query, onBatch) {
    const { batches, meta } = await read(kind, query, history);
    query.onMeta?.(meta);
    let count = 0;
    let cellCount = 0;
    for (const [sequence, bars] of batches.entries()) {
      const barCellCounts = cellCounts(bars);
      const cells = barCellCounts.reduce((sum, n) => sum + n, 0);
      count += bars.length;
      cellCount += cells;
      await onBatch({ bars, sequence, meta, cellCount: cells, barCellCounts });
    }
    return { count, cellCount };
  }

  /** @param {CallKind} kind @param {Record<string, any>} query @param {ReadHandler} handler */
  async function readBars(kind, query, handler) {
    const { batches, meta } = await read(kind, query, handler);
    query.onMeta?.(meta);
    return batches.flat();
  }

  const source = {
    /** Every call in the order it arrived, tagged with the port method's `kind`. */
    queries,
    /** @param {CallKind} kind */
    queriesOf: (kind) => queries.filter((query) => query.kind === kind),
    /** @param {any} query @param {(batch: any) => void | Promise<void>} onBatch */
    streamHistory: (query, onBatch) => stream("stream", query, onBatch),
    /** @param {any} query */
    collectHistory: async (query) => {
      /** @type {FootprintBar[]} */
      const bars = [];
      await stream("collect", query, (batch) => { bars.push(...batch.bars); });
      return bars;
    },
    /** @param {any} query */
    fetchHistory: (query) => readBars("fetch", query, history),
    /** @param {any} query */
    fetchLiveOhlc: (query) => readBars("liveOhlc", query, liveOhlc),
    /** @param {any} query */
    fetchSharedLiveOhlc: (query) => readBars("sharedLiveOhlc", query, liveOhlc),
    /** @param {any} query */
    fetchRepairHistory: (query) => readBars("repair", query, repair),
    /**
     * @param {string[]} markets @param {number} interval @param {number} priceStep
     * @param {string | undefined} reference @param {number} from @param {number} to @param {AbortSignal} [signal]
     */
    startRefresh: async (markets, interval, priceStep, reference, from, to, signal) => {
      const request = { kind: /** @type {const} */ ("startRefresh"), markets, interval, priceStep, reference, from, to, signal };
      queries.push(request);
      await options.startRefresh?.(request);
    },
    /** @param {AbortSignal} [signal] */
    fetchRefreshStatus: async (signal) => {
      queries.push({ kind: "refreshStatus", signal });
      return options.refreshStatus?.() ?? { state: "idle", total: 0, done: 0, frac: 0, lastDoneAt: 0 };
    },
    /** @param {string} market */
    isDirectCandleMarket: (market) => directCandleMarkets.has(market),
    initialHistoryBars: options.initialHistoryBars ?? 4000,
  };
  return source;
}

/**
 * Create a fake and install it as the chart's data source for one test.
 * @param {{ after(fn: () => void): void }} t
 * @param {Parameters<typeof createFakeChartDataSource>[0]} [options]
 */
export function useFakeChartDataSource(t, options) {
  const source = createFakeChartDataSource(options);
  configureChartDataSource(source);
  // Back to no data source at all, as the other engine tests run.
  t.after(() => configureChartDataSource(/** @type {any} */ (null)));
  return source;
}

/**
 * A history bar as the port delivers it. `cells` lists cell objects; any field left
 * out keeps the default a parsed `/history` bar has.
 * @param {number} startTime
 * @param {Partial<Omit<FootprintBar, "cells">> & { cells?: Array<Record<string, number> & { priceBin: number }> }} [fields]
 * @returns {FootprintBar}
 */
export function historyBar(startTime, fields = {}) {
  const { cells = [], ...rest } = fields;
  return {
    startTime,
    open: 0, high: 0, low: 0, close: 0, volume: 0, delta: 0,
    count: 0, liquidationBuyVol: 0, liquidationSellVol: 0,
    hasRef: true, completeness: "complete", sources: ["history"], updatedAt: Date.now(),
    ...rest,
    cells: new Map(cells.map((cell) => [cell.priceBin, /** @type {any} */ (cell)])),
  };
}
