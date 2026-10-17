import type { FootprintSeries } from "../../core/model/footprint.js";

/** Stable runtime identity that owns a raw source capture. */
export type RawSourceOwner = object;

/** Chart identity a raw capture is bound to. */
export interface RawChartContext {
  readonly market: string;
  readonly timeframe: string;
  readonly intervalMs: number;
}

/** Read-only identity of the canonical raw series; bars are never cloned or mutated. */
export interface RawSourceIdentity {
  readonly owner: RawSourceOwner;
  readonly series: FootprintSeries;
  readonly market: string;
  readonly timeframe: string;
  readonly intervalMs: number;
  readonly resetEpoch: number;
  readonly revision: number;
  readonly structureRevision: number;
}

export type IndicatorInputSource = "raw" | "view";

export type RawIndicatorInput =
  | { readonly status: "raw"; readonly source: RawSourceIdentity }
  | { readonly status: "unsupported"; readonly requested: "view"; readonly reason: "view-adapter-unavailable" };

export type RawCursorMode = "raw" | "synthetic-noninvertible";

export type RawUnknownReason = "stale-source" | "empty" | "non-finite" | "outside-source" | "non-invertible";

export interface RawTimeKnown {
  readonly status: "known";
  readonly time: number;
  readonly source: RawSourceIdentity;
}
export interface RawTimeUnknown {
  readonly status: "unknown";
  readonly reason: RawUnknownReason;
}
export type RawTimeResolution = RawTimeKnown | RawTimeUnknown;

export interface RawPriceKnown {
  readonly status: "known";
  readonly price: number;
  readonly source: RawSourceIdentity;
}
export interface RawPriceUnknown {
  readonly status: "unknown";
  readonly reason: RawUnknownReason;
}
export type RawPriceResolution = RawPriceKnown | RawPriceUnknown;

export interface RawCursorResolution {
  readonly time: RawTimeResolution;
  readonly price: RawPriceResolution;
}

/** Captures raw series identity; pure read, no mutation or cloning of canonical bars. */
export function captureRawSource(
  owner: RawSourceOwner,
  series: FootprintSeries,
  chart: RawChartContext,
): RawSourceIdentity {
  return {
    owner,
    series,
    market: chart.market,
    timeframe: chart.timeframe,
    intervalMs: chart.intervalMs,
    resetEpoch: series.resetEpoch,
    revision: series.revision,
    structureRevision: series.structureRevision,
  };
}

/** True only when every identity field matches, including series reference and counters. */
export function sameRawSource(a: RawSourceIdentity, b: RawSourceIdentity): boolean {
  return a.owner === b.owner
    && a.series === b.series
    && a.market === b.market
    && a.timeframe === b.timeframe
    && a.intervalMs === b.intervalMs
    && a.resetEpoch === b.resetEpoch
    && a.revision === b.revision
    && a.structureRevision === b.structureRevision;
}

/** Raw is the default input; the view adapter is not available yet. */
export function resolveIndicatorInput(
  input: IndicatorInputSource | undefined,
  source: RawSourceIdentity,
): RawIndicatorInput {
  if (input === "view") return { status: "unsupported", requested: "view", reason: "view-adapter-unavailable" };
  return { status: "raw", source };
}

function isStaleSource(source: RawSourceIdentity): boolean {
  const series = source.series;
  return source.resetEpoch !== series.resetEpoch
    || source.revision !== series.revision
    || source.structureRevision !== series.structureRevision;
}

function resolveTime(source: RawSourceIdentity, ordinal: number): RawTimeResolution {
  const series = source.series;
  if (!Number.isFinite(ordinal)) return { status: "unknown", reason: "non-finite" };
  if (series.length === 0) return { status: "unknown", reason: "empty" };
  if (ordinal < 0 || ordinal >= series.length) return { status: "unknown", reason: "outside-source" };
  const time: number | null = series.timeOfIndex(ordinal);
  if (time === null || !Number.isFinite(time)) return { status: "unknown", reason: "outside-source" };
  const bar = series.at(Math.floor(ordinal));
  const intervalMs = series.config.intervalMs;
  if (!bar || time < bar.startTime || time >= bar.startTime + intervalMs) {
    return { status: "unknown", reason: "outside-source" };
  }
  return { status: "known", time, source };
}

function resolvePrice(source: RawSourceIdentity, price: number, mode: RawCursorMode): RawPriceResolution {
  if (!Number.isFinite(price)) return { status: "unknown", reason: "non-finite" };
  if (mode === "synthetic-noninvertible") return { status: "unknown", reason: "non-invertible" };
  return { status: "known", price, source };
}

/**
 * Raw cursor contract: time is known only when the interpolated time falls inside the
 * floor(ordinal) bar's [start, start+interval) coverage; price is a raw axis coordinate.
 */
export function resolveRawCursor(
  source: RawSourceIdentity,
  ordinal: number,
  price: number,
  mode: RawCursorMode,
): RawCursorResolution {
  if (isStaleSource(source)) {
    return {
      time: { status: "unknown", reason: "stale-source" },
      price: { status: "unknown", reason: "stale-source" },
    };
  }
  return { time: resolveTime(source, ordinal), price: resolvePrice(source, price, mode) };
}
