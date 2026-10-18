// Liquidation series over a plain JSON `/api/metrics/liquidations` endpoint, so load
// specs can give the Liquidations indicator data with Playwright routes. One request
// per market and interval; the state goes loading -> ready (or error) and the
// indicator's onUpdate fires once it settles.
import type {
  CoinalyzeInterval,
  LiquidationMetricSeries,
  LiquidationRequestInput,
  LiquidationSeriesState,
} from "../src/features/indicators/metricContracts.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const INTERVALS: ReadonlyArray<[number, CoinalyzeInterval]> = [
  [MIN, "1min"], [5 * MIN, "5min"], [15 * MIN, "15min"], [30 * MIN, "30min"],
  [HOUR, "1hour"], [2 * HOUR, "2hour"], [4 * HOUR, "4hour"], [6 * HOUR, "6hour"], [12 * HOUR, "12hour"], [DAY, "daily"],
];

/** How far back each interval asks for, matching what a host typically loads. */
const LOOKBACK_MS: Record<CoinalyzeInterval, number> = {
  "1min": DAY, "5min": 3 * DAY, "15min": 7 * DAY, "30min": 14 * DAY, "1hour": 30 * DAY,
  "2hour": 60 * DAY, "4hour": 90 * DAY, "6hour": 180 * DAY, "12hour": 365 * DAY, daily: 2 * 365 * DAY,
};

function sourceInterval(intervalMs: number): CoinalyzeInterval | null {
  if (intervalMs >= DAY) return "daily";
  for (let i = INTERVALS.length - 1; i >= 0; i--) {
    const [ms, name] = INTERVALS[i];
    if (intervalMs >= ms && intervalMs % ms === 0) return name;
  }
  return null;
}

function baseAsset(market: string): string {
  const pair = (market.includes(":") ? market.slice(market.indexOf(":") + 1) : market).toUpperCase();
  return pair.replace(/(USDT|USDC|USD)$/, "") || pair;
}

const states = new Map<string, LiquidationSeriesState>();
const listeners = new Map<string, Set<() => void>>();

export function requestLiquidationSeries(input: LiquidationRequestInput): LiquidationSeriesState {
  const interval = sourceInterval(input.intervalMs);
  if (!interval) return { status: "unsupported", message: `no liquidation interval for ${input.timeframe}` };
  const exchanges = Object.keys(input.exchanges).filter((key) => input.exchanges[key]);
  const marketTypes = Object.entries(input.marketTypes).filter(([, on]) => on).map(([key]) => key);
  if (!exchanges.length || !marketTypes.length) return { status: "unsupported", message: "no exchange or market type selected" };

  const base = baseAsset(input.market);
  const key = `${base}|${interval}|${exchanges.join(",")}|${marketTypes.join(",")}`;
  const existing = states.get(key);
  if (existing && existing.status !== "loading") return existing;
  if (input.onUpdate) {
    let set = listeners.get(key);
    if (!set) listeners.set(key, set = new Set());
    set.add(input.onUpdate);
  }
  if (existing) return existing;

  const loading: LiquidationSeriesState = { status: "loading" };
  states.set(key, loading);
  const to = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    base,
    interval,
    from: String(to - LOOKBACK_MS[interval] / 1000),
    to: String(to),
    exchanges: exchanges.join(","),
    marketTypes: marketTypes.join(","),
  });
  void fetch(`/api/metrics/liquidations?${params.toString()}`)
    .then(async (response) => {
      const body = await response.json().catch(() => null) as { ok?: boolean; data?: LiquidationMetricSeries } | null;
      if (!response.ok || !body?.ok || !body.data) throw new Error(`liquidations HTTP ${response.status}`);
      return { status: "ready", data: body.data } as const;
    })
    .catch((error: unknown) => ({ status: "error", message: String(error) }) as const)
    .then((state) => {
      states.set(key, state);
      const set = listeners.get(key);
      listeners.delete(key);
      for (const listener of set ?? []) listener();
    });
  return loading;
}
