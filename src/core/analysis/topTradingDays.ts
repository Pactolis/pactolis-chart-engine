export type TradingDaySortKey =
  | "date"
  | "tradeCount"
  | "quoteVolume"
  | "quoteVolumePerTrade"
  | "liqTotalUsd"
  | "liqBuyUsd"
  | "liqSellUsd";

export type TradingDayLiqSource = "coinalyze_aggregated" | "local_binance_fallback" | "none" | string;
export type SortDirection = "asc" | "desc";

export interface TradingDayLiqComponent {
  key: string;
  label: string;
  liqBuyUsd: number;
  liqSellUsd: number;
  liqTotalUsd: number;
  symbolCount: number;
}

export interface TradingDayStat {
  date: string;
  time: number;
  tradeCount: number;
  quoteVolume: number;
  quoteVolumePerTrade: number;
  liqBuyUsd?: number;
  liqSellUsd?: number;
  liqTotalUsd?: number;
  liqSource?: TradingDayLiqSource;
  liqSymbolCount?: number;
  liqExchangeCount?: number;
  liqExchangeLabels?: string[];
  liqComponents?: TradingDayLiqComponent[];
}

const TOP_DAYS_LIMIT = 100;

function topBy(
  rows: readonly TradingDayStat[],
  key: Exclude<TradingDaySortKey, "date">
): TradingDayStat[] {
  return [...rows]
    .filter((row) => {
      if (key === "quoteVolumePerTrade") return row.tradeCount > 0;
      if (key === "liqTotalUsd" || key === "liqBuyUsd" || key === "liqSellUsd")
        return (row[key] ?? 0) > 0;
      return true;
    })
    .sort((a, b) => ((b[key] ?? 0) - (a[key] ?? 0)) || b.time - a.time)
    .slice(0, TOP_DAYS_LIMIT);
}

export function selectTopTradingDays(
  rows: readonly TradingDayStat[]
): TradingDayStat[] {
  const selected = new Map<number, TradingDayStat>();
  for (const key of [
    "tradeCount",
    "quoteVolume",
    "quoteVolumePerTrade",
    "liqTotalUsd",
  ] as const) {
    for (const row of topBy(rows, key)) selected.set(row.time, row);
  }
  return [...selected.values()].sort((a, b) => b.time - a.time);
}

export function sortTradingDays(
  rows: readonly TradingDayStat[],
  key: TradingDaySortKey,
  direction: SortDirection
): TradingDayStat[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = key === "date" ? a.time : (a[key] ?? 0);
    const bv = key === "date" ? b.time : (b[key] ?? 0);
    const primary = (av - bv) * sign;
    return primary || b.time - a.time;
  });
}
