import type { FootprintBar } from "./types.js";

export type ChartDataUpdateKind =
  | "history-loaded"
  | "history-patched"
  | "metadata-updated"
  | "price-step-reset"
  | "same-bar-update"
  | "new-bar-appended"
  | "series-cleared"
  | "replay-reset"
  | "replay-step";

export type ChartDataUpdateSource = "history" | "live" | "metadata" | "config" | "replay";

export interface ChartDataSnapshot {
  readonly length: number;
  readonly lastBarStart: number | null;
}

export interface ChartDataUpdateEvent {
  readonly kind: ChartDataUpdateKind;
  readonly source: ChartDataUpdateSource;
  readonly previous: ChartDataSnapshot;
  readonly next: ChartDataSnapshot;
  readonly priceChanged?: boolean;
}

export function snapshotFromSeries(series: { readonly length: number; at(index: number): FootprintBar | undefined }): ChartDataSnapshot {
  const length = Math.max(0, series.length);
  const last = length > 0 ? series.at(length - 1) : undefined;
  return {
    length,
    lastBarStart: last?.startTime ?? null,
  };
}

export function makeDataUpdateEvent(
  kind: ChartDataUpdateKind,
  source: ChartDataUpdateSource,
  previous: ChartDataSnapshot,
  next: ChartDataSnapshot,
  metadata?: { priceChanged?: boolean },
): ChartDataUpdateEvent {
  return { kind, source, previous, next, ...metadata };
}

export function classifyLiveTradeUpdate(previous: ChartDataSnapshot, next: ChartDataSnapshot): ChartDataUpdateKind {
  if (next.length <= 0) return "series-cleared";
  if (next.length > previous.length) return "new-bar-appended";
  if (previous.lastBarStart !== null && next.lastBarStart !== previous.lastBarStart) return "new-bar-appended";
  return "same-bar-update";
}

export function classifyReplayStepUpdate(previous: ChartDataSnapshot, next: ChartDataSnapshot): ChartDataUpdateKind {
  if (next.length <= 0) return "series-cleared";
  if (next.length > previous.length) return "replay-step";
  if (previous.lastBarStart !== null && next.lastBarStart !== previous.lastBarStart) return "replay-step";
  return "same-bar-update";
}
