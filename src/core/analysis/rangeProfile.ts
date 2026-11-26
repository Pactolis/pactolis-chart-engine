import type { FootprintBar } from "../types.js";
import { bucketEnd, bucketStart } from "../time.js";
import {
  accumulateOrderFlowOiDeltaBar,
  calculateOrderFlowProfile,
  createOrderFlowProfileAccumulator,
  finishOrderFlowProfile,
  type OrderFlowProfileOptions,
  type OrderFlowProfileResult,
} from "./orderFlowProfile.js";
import {
  calculateVolumeProfile,
  type VolumeProfileResult,
} from "./volumeProfile.js";
import {
  computeBarOiDeltas,
  parseOiResolutionMs,
} from "../../features/indicators/builtins/oiDeltaProfile.js";
import type { OpenInterestSeriesResponse, OpenInterestVenue } from "../../features/indicators/metricContracts.js";

export interface RangeProfileResult extends VolumeProfileResult {
  requestedFrom: number;
  requestedTo: number;
  /** Selected bars carrying at least one exact footprint cell. */
  coveredBars: number;
  totalBars: number;
  /** Fraction of selected bars carrying exact footprint cells. */
  coverage: number;
  /** Days with one or more selected bars that have no footprint cells. */
  missingDays: number[];
  /** True only when the selection is nonempty and every selected bar has footprint cells. */
  complete: boolean;
}

export interface OrderFlowRangeProfileResult extends OrderFlowProfileResult {
  requestedFrom: number;
  requestedTo: number;
  coveredBars: number;
  totalBars: number;
  coverage: number;
  missingDays: number[];
  complete: boolean;
}

export interface OiDeltaRangeMeta {
  resolution: string;
  resolutionMs: number;
  activeVenueCount: number;
  coveragePercent: number;
  coveredBarCount: number;
  totalBarCount: number;
  effectiveRecordingStartedAt: number | null;
  firstBarTime: number | null;
  source?: "backend" | "browser" | "instant-only";
}

export interface OiDeltaRangeProfileResult extends OrderFlowRangeProfileResult {
  oiMeta: OiDeltaRangeMeta;
}

const DAY = 86_400_000;

export function calculateRangeProfile(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  valueAreaPercent = 0.7
): RangeProfileResult {
  const selection = selectRangeBars(bars, from, to);
  const profile = calculateVolumeProfile(
    selection.selected.filter((bar) => bar.cells.size > 0),
    valueAreaPercent
  );
  return { ...profile, ...selection.meta };
}

export function calculateOrderFlowRangeProfile(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  options: OrderFlowProfileOptions = {},
): OrderFlowRangeProfileResult {
  const selection = selectRangeBars(bars, from, to);
  const { coveredBars, totalBars } = selection.meta;
  const canEstimateWholeRange = totalBars > 0 && coveredBars === 0
    && options.allowOhlcvEstimate === true
    && typeof options.priceStep === "number"
    && Number.isFinite(options.priceStep)
    && options.priceStep > 0;
  const profileBars = canEstimateWholeRange
    // An incomplete footprint window is estimated from OHLCV for every selected bar.
    // Clearing all cell maps prevents exact and estimated levels from being mixed.
    ? selection.selected.map((bar) => ({ ...bar, cells: new Map() }))
    : selection.selected.filter((bar) => bar.cells.size > 0);
  const profile = calculateOrderFlowProfile(profileBars, options);
  return { ...profile, ...selection.meta };
}

export function calculateOiDeltaRangeProfile(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
  intervalMs: number,
  response: OpenInterestSeriesResponse,
  selectedVenues: readonly OpenInterestVenue[],
  options: OrderFlowProfileOptions = {},
): OiDeltaRangeProfileResult {
  const selection = selectRangeBars(bars, from, to);
  const oiOptions: OrderFlowProfileOptions = {
    ...options,
    profileMetric: "oi-delta",
    profileSide: "total",
    allowOhlcvEstimate: options.allowOhlcvEstimate ?? true,
  };
  const resolution = response.resolution || "";
  const resolutionMs = parseOiResolutionMs(resolution, intervalMs);
  if (selection.selected.length === 0) {
    const empty = finishOrderFlowProfile(createOrderFlowProfileAccumulator(), oiOptions);
    return {
      ...empty,
      ...selection.meta,
      oiMeta: {
        resolution,
        resolutionMs,
        activeVenueCount: 0,
        coveragePercent: 0,
        coveredBarCount: 0,
        totalBarCount: 0,
        effectiveRecordingStartedAt: null,
        firstBarTime: null,
        source: response.source,
      },
    };
  }

  const start = selection.meta.requestedFrom;
  const end = selection.meta.requestedTo;
  const compBars = intervalMs < resolutionMs
    ? (() => {
      const slotFrom = bucketStart(start, resolutionMs);
      const slotTo = bucketEnd(end, resolutionMs);
      return bars.filter((bar) => bar.startTime >= slotFrom && bar.startTime < slotTo);
    })()
    : selection.selected;

  const comp = computeBarOiDeltas(compBars, intervalMs, response, selectedVenues);
  const acc = createOrderFlowProfileAccumulator();
  let coveredInRange = 0;
  for (let i = 0; i < compBars.length; i += 1) {
    const bar = compBars[i];
    if (bar.startTime < start || bar.startTime > end) continue;
    if (accumulateOrderFlowOiDeltaBar(acc, bar, comp.barDeltas[i], oiOptions)) {
      coveredInRange += 1;
    }
  }

  const profile = finishOrderFlowProfile(acc, oiOptions);
  const totalInRange = selection.selected.length;
  const coveragePercent = totalInRange > 0 ? Math.round((coveredInRange / totalInRange) * 100) : 0;

  return {
    ...profile,
    ...selection.meta,
    oiMeta: {
      resolution: comp.resolution,
      resolutionMs: comp.resolutionMs,
      activeVenueCount: comp.activeVenueCount,
      coveragePercent,
      coveredBarCount: coveredInRange,
      totalBarCount: totalInRange,
      effectiveRecordingStartedAt: comp.effectiveRecordingStartedAt,
      firstBarTime: selection.selected[0]?.startTime ?? null,
      source: comp.source,
    },
  };
}

function selectRangeBars(
  bars: readonly FootprintBar[],
  from: number,
  to: number,
): {
  selected: FootprintBar[];
  meta: Pick<RangeProfileResult, "requestedFrom" | "requestedTo" | "coveredBars" | "totalBars" | "coverage" | "missingDays" | "complete">;
} {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const selected = bars.filter((bar) => bar.startTime >= start && bar.startTime <= end);
  const coveredBars = selected.filter((bar) => bar.cells.size > 0).length;
  const missingDays = [...new Set(selected
    .filter((bar) => bar.volume > 0 && bar.cells.size === 0)
    .map((bar) => Math.floor(bar.startTime / DAY) * DAY))]
    .sort((a, b) => a - b);
  const totalBars = selected.length;
  return {
    selected,
    meta: {
      requestedFrom: start,
      requestedTo: end,
      coveredBars,
      totalBars,
      coverage: totalBars ? coveredBars / totalBars : 0,
      missingDays,
      complete: totalBars > 0 && missingDays.length === 0,
    },
  };
}
