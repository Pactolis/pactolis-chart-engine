import { tOr } from "../../../core/chartLocaleFallbacks.js";
import type { OiDeltaDisplay } from "../../../core/orderFlowProfileSettings.js";
import { bucketEnd, bucketStart } from "../../../core/time.js";
import type { FootprintBar } from "../../../core/types.js";
import { tzDateTimeHud } from "../../../core/tzFormat.js";
import type {
  OpenInterestGap,
  OpenInterestPoint,
  OpenInterestSeriesResponse,
  OpenInterestVenue,
} from "../metricContracts.js";

export interface OiDeltaComputationResult {
  barDeltas: (number | null)[];
  resolution: string;
  resolutionMs: number;
  totalBarCount: number;
  coveredBarCount: number;
  coveragePercent: number;
  activeVenueCount: number;
  effectiveRecordingStartedAt: number | null;
  source?: "backend" | "browser" | "instant-only";
}

interface VenueState {
  venue: OpenInterestVenue;
  points: OpenInterestPoint[];
  startBoundary: number | null;
  gaps: readonly OpenInterestGap[] | undefined;
}

export function parseOiResolutionMs(resolution: string | undefined, fallbackMs: number): number {
  if (!resolution) return fallbackMs;
  const trimmed = resolution.trim().toLowerCase();
  if (trimmed === "daily" || trimmed === "1d") return 86_400_000;
  const match = /^(\d+)\s*(m|min|h|hour|d|w)$/.exec(trimmed);
  if (!match) return fallbackMs;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return fallbackMs;
  const unit = match[2];
  if (unit === "m" || unit === "min") return count * 60_000;
  if (unit === "h" || unit === "hour") return count * 3_600_000;
  if (unit === "d") return count * 86_400_000;
  if (unit === "w") return count * 7 * 86_400_000;
  return fallbackMs;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function effectiveStartBoundary(
  historyStartedAt: number | null | undefined,
  recordingStartedAt: number | null | undefined,
): number | null {
  const hist = finiteOrNull(historyStartedAt);
  const rec = finiteOrNull(recordingStartedAt);
  if (hist !== null && rec !== null) return Math.min(hist, rec);
  return hist ?? rec;
}

function isTimeInGap(
  time: number,
  gaps: readonly OpenInterestGap[] | undefined,
  allowBoundaryAt?: number,
): boolean {
  if (!gaps || !gaps.length) return false;
  for (const gap of gaps) {
    if (time >= gap.from && time < gap.to) {
      if (allowBoundaryAt !== undefined && time === allowBoundaryAt && time === gap.from) continue;
      return true;
    }
  }
  return false;
}

function intervalOverlapsGap(start: number, end: number, gaps: readonly OpenInterestGap[] | undefined): boolean {
  if (!gaps || !gaps.length) return false;
  for (const gap of gaps) {
    if (gap.from < end && gap.to > start) return true;
  }
  return false;
}

function upperBoundPointIndex(points: readonly OpenInterestPoint[], targetTime: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time <= targetTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function latestValidPointInRange(
  points: readonly OpenInterestPoint[],
  minTimeExclusive: number,
  maxTimeInclusive: number,
  venueGaps: readonly OpenInterestGap[] | undefined,
  responseGaps: readonly OpenInterestGap[] | undefined,
): OpenInterestPoint | null {
  let idx = upperBoundPointIndex(points, maxTimeInclusive) - 1;
  while (idx >= 0) {
    const pt = points[idx];
    if (pt.time <= minTimeExclusive) return null;
    if (
      Number.isFinite(pt.value)
      && !isTimeInGap(pt.time, venueGaps, maxTimeInclusive)
      && !isTimeInGap(pt.time, responseGaps, maxTimeInclusive)
    ) {
      return pt;
    }
    idx -= 1;
  }
  return null;
}

function createVenueStates(
  response: OpenInterestSeriesResponse,
  selectedVenues: readonly OpenInterestVenue[],
): VenueState[] {
  const selectedSet = new Set(selectedVenues);
  const responseStart = effectiveStartBoundary(response.historyStartedAt, response.recordingStartedAt);
  const states: VenueState[] = [];
  for (const venueSeries of response.venues) {
    if (!selectedSet.has(venueSeries.venue)) continue;
    const sorted = isSortedAscending(venueSeries.points)
      ? venueSeries.points
      : [...venueSeries.points].sort((a, b) => a.time - b.time);
    const venueStart = effectiveStartBoundary(venueSeries.historyStartedAt, venueSeries.recordingStartedAt);
    const startBoundary = venueStart !== null && responseStart !== null
      ? Math.max(venueStart, responseStart)
      : venueStart ?? responseStart;
    states.push({
      venue: venueSeries.venue,
      points: sorted,
      startBoundary,
      gaps: venueSeries.gaps,
    });
  }
  return states;
}

function isSortedAscending(points: readonly OpenInterestPoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].time < points[i - 1].time) return false;
  }
  return true;
}

export function computeIntervalVenueDelta(
  state: VenueState,
  startTime: number,
  endTime: number,
  resolutionMs: number,
  responseGaps: readonly OpenInterestGap[] | undefined,
): number | null {
  if (state.points.length === 0) return null;
  if (state.startBoundary !== null && startTime < state.startBoundary) return null;
  if (intervalOverlapsGap(startTime, endTime, state.gaps)) return null;
  if (intervalOverlapsGap(startTime, endTime, responseGaps)) return null;

  const startSample = latestValidPointInRange(
    state.points,
    startTime - resolutionMs,
    startTime,
    state.gaps,
    responseGaps,
  );
  if (!startSample) return null;

  const endSample = latestValidPointInRange(
    state.points,
    startTime,
    endTime,
    state.gaps,
    responseGaps,
  );
  if (!endSample) return null;

  return endSample.value - startSample.value;
}

function computeIntervalTotalDelta(
  venueStates: readonly VenueState[],
  startTime: number,
  endTime: number,
  resolutionMs: number,
  responseGaps: readonly OpenInterestGap[] | undefined,
): number | null {
  let sum = 0;
  let coveredVenues = 0;
  for (const state of venueStates) {
    const delta = computeIntervalVenueDelta(state, startTime, endTime, resolutionMs, responseGaps);
    if (delta !== null && Number.isFinite(delta)) {
      sum += delta;
      coveredVenues += 1;
    }
  }
  return coveredVenues > 0 ? sum : null;
}

export function computeBarOiDeltas(
  bars: readonly FootprintBar[],
  intervalMs: number,
  response: OpenInterestSeriesResponse,
  selectedVenues: readonly OpenInterestVenue[],
): OiDeltaComputationResult {
  const resolution = response.resolution || "";
  const resolutionMs = parseOiResolutionMs(resolution, intervalMs);
  const venueStates = createVenueStates(response, selectedVenues);
  const barDeltas: (number | null)[] = new Array(bars.length).fill(null);

  let effectiveRecordingStartedAt = effectiveStartBoundary(response.historyStartedAt, response.recordingStartedAt);
  let activeVenueCount = 0;
  for (const state of venueStates) {
    if (state.points.length > 0) activeVenueCount += 1;
    if (state.startBoundary !== null) {
      effectiveRecordingStartedAt = effectiveRecordingStartedAt === null
        ? state.startBoundary
        : Math.min(effectiveRecordingStartedAt, state.startBoundary);
    }
  }

  let coveredBarCount = 0;
  if (bars.length > 0 && venueStates.length > 0) {
    if (intervalMs >= resolutionMs) {
      for (let i = 0; i < bars.length; i += 1) {
        const barStart = bars[i].startTime;
        const barEnd = bucketEnd(barStart, intervalMs);
        const delta = computeIntervalTotalDelta(venueStates, barStart, barEnd, resolutionMs, response.gaps);
        barDeltas[i] = delta;
        if (delta !== null) coveredBarCount += 1;
      }
    } else {
      let i = 0;
      while (i < bars.length) {
        const slotStart = bucketStart(bars[i].startTime, resolutionMs);
        const slotEnd = bucketEnd(slotStart, resolutionMs);
        let j = i + 1;
        while (j < bars.length && bucketStart(bars[j].startTime, resolutionMs) === slotStart) {
          j += 1;
        }
        const slotDelta = computeIntervalTotalDelta(venueStates, slotStart, slotEnd, resolutionMs, response.gaps);
        if (slotDelta !== null) {
          const count = j - i;
          coveredBarCount += count;
          let totalSlotVol = 0;
          for (let k = i; k < j; k += 1) {
            const v = bars[k].volume;
            if (typeof v === "number" && Number.isFinite(v) && v > 0) totalSlotVol += v;
          }
          if (totalSlotVol > 0) {
            for (let k = i; k < j; k += 1) {
              const v = bars[k].volume;
              const weight = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
              barDeltas[k] = slotDelta * (weight / totalSlotVol);
            }
          } else {
            const equalShare = slotDelta / count;
            for (let k = i; k < j; k += 1) {
              barDeltas[k] = equalShare;
            }
          }
        }
        i = j;
      }
    }
  }

  const totalBarCount = bars.length;
  const coveragePercent = totalBarCount > 0 ? Math.round((coveredBarCount / totalBarCount) * 100) : 0;

  return {
    barDeltas,
    resolution,
    resolutionMs,
    totalBarCount,
    coveredBarCount,
    coveragePercent,
    activeVenueCount,
    effectiveRecordingStartedAt,
    source: response.source,
  };
}

export function buildOiRevisionKey(
  response: OpenInterestSeriesResponse,
  selectedVenues: readonly OpenInterestVenue[],
  oiDeltaDisplay: OiDeltaDisplay,
): string {
  const selectedSet = new Set(selectedVenues);
  const venueTokens: string[] = [];
  for (const v of response.venues) {
    if (!selectedSet.has(v.venue)) continue;
    const firstPt = v.points[0];
    const lastPt = v.points[v.points.length - 1];
    venueTokens.push(
      `${v.venue}:${v.points.length}:${firstPt?.time ?? ""}:${lastPt?.time ?? ""}:${lastPt?.value ?? ""}:${v.gaps?.length ?? 0}:${v.recordingStartedAt ?? ""}:${v.historyStartedAt ?? ""}`,
    );
  }
  return [
    response.status ?? "ok",
    response.resolution,
    response.source ?? "",
    response.recordingStartedAt ?? "",
    response.historyStartedAt ?? "",
    response.gaps?.length ?? 0,
    selectedVenues.join(","),
    oiDeltaDisplay,
    venueTokens.join(";"),
  ].join("#");
}

function formatResolutionLabel(resolution: string, isTurkish: boolean): string {
  if (!resolution) return "";
  if (!isTurkish) return resolution;
  const trimmed = resolution.trim().toLowerCase();
  if (trimmed === "daily" || trimmed === "1d") return "1 gün";
  const match = /^(\d+)\s*(m|min|h|hour|d|w)$/.exec(trimmed);
  if (!match) return resolution;
  const count = match[1];
  const unit = match[2];
  if (unit === "m" || unit === "min") return `${count} dk`;
  if (unit === "h" || unit === "hour") return `${count} sa`;
  if (unit === "d") return `${count} gün`;
  if (unit === "w") return `${count} hf`;
  return resolution;
}

export function formatOiDeltaBadge(
  meta: {
    resolution: string;
    activeVenueCount: number;
    coveragePercent: number;
    effectiveRecordingStartedAt: number | null;
    firstBarTime: number | null;
    source?: "backend" | "browser" | "instant-only";
  },
  isEstimated: boolean,
  intervalMs: number,
  localeTag: string,
): string {
  const lang = localeTag.toLowerCase();
  const isTr = lang === "tr" || lang.startsWith("tr-") || lang.startsWith("tr_");

  if (
    meta.coveragePercent < 100
    && meta.effectiveRecordingStartedAt !== null
    && meta.firstBarTime !== null
    && meta.firstBarTime < meta.effectiveRecordingStartedAt
  ) {
    const timeText = tzDateTimeHud(meta.effectiveRecordingStartedAt, intervalMs);
    return tOr("indicator.volumeProfile.oiRecordingSince", {
      time: timeText,
      percent: meta.coveragePercent,
    });
  }

  const parts: string[] = [];
  const resText = formatResolutionLabel(meta.resolution, isTr);
  parts.push(resText ? `OI ${resText}` : "OI");
  parts.push(isTr ? `${meta.activeVenueCount} borsa` : `${meta.activeVenueCount} venues`);
  if (meta.source === "browser" || meta.source === "instant-only") {
    parts.push(meta.source);
  }
  if (isEstimated) {
    parts.push(tOr("indicator.volumeProfile.oiEstimated"));
  }
  if (meta.coveragePercent < 100) {
    parts.push(tOr("indicator.volumeProfile.oiCoverage", { percent: meta.coveragePercent }));
  }
  return parts.join(" · ");
}
