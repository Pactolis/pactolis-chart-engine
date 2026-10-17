export interface HistorySelection {
  markets: readonly string[];
  reference: string | undefined;
  intervalMs: number;
  priceStep: number;
}

export function sameHistorySelection(
  left: HistorySelection,
  right: HistorySelection
): boolean {
  return (
    left.reference === right.reference &&
    left.intervalMs === right.intervalMs &&
    left.priceStep === right.priceStep &&
    left.markets.length === right.markets.length &&
    left.markets.every((market, index) => market === right.markets[index])
  );
}

/** Keep the last measurable user-owned center while a queued config change has emptied the series. */
export function retainPendingTimeframeAnchor(
  pending: number | null,
  measured: number | null
): number | null {
  return measured ?? pending;
}
