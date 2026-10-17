import type { FootprintBar } from "../types.js";
import { addCompensated, createCompensatedSum } from "./calc/ta.js";

export type VwapId =
  | "rolling-24h" | "rolling-7d" | "rolling-30d" | "rolling-90d" | "rolling-365d"
  | "current-daily" | "current-weekly" | "current-monthly"
  | "current-quarterly" | "current-half-yearly" | "current-yearly"
  | "previous-weekly" | "previous-monthly" | "previous-quarterly"
  | "previous-half-yearly" | "previous-yearly";

export type VwapFamily = "rolling" | "current" | "previous";
export type CalendarPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "half-yearly" | "yearly";

export interface VwapDefinition {
  id: VwapId;
  label: string;
  family: VwapFamily;
  color: string;
  windowMs?: number;
  period?: CalendarPeriod;
}

export interface VwapPoint {
  time: number;
  value: number | null;
}

export interface VwapSeries {
  id: VwapId;
  points: VwapPoint[];
  available: boolean;
}

const DAY = 86_400_000;

function typicalPrice(bar: FootprintBar): number {
  return (bar.high + bar.low + bar.close) / 3;
}

export function calendarPeriodStart(time: number, period: CalendarPeriod): number {
  const d = new Date(time);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (period === "yearly") return Date.UTC(year, 0, 1);
  if (period === "half-yearly") return Date.UTC(year, month < 6 ? 0 : 6, 1);
  if (period === "quarterly") return Date.UTC(year, Math.floor(month / 3) * 3, 1);
  if (period === "monthly") return Date.UTC(year, month, 1);
  const day = Date.UTC(year, month, d.getUTCDate());
  if (period === "weekly") return day - ((d.getUTCDay() + 6) % 7) * DAY;
  return day;
}

function previousPeriodStart(start: number, period: CalendarPeriod): number {
  const d = new Date(start);
  if (period === "yearly") return Date.UTC(d.getUTCFullYear() - 1, 0, 1);
  if (period === "half-yearly") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, 1);
  if (period === "quarterly") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1);
  if (period === "monthly") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  if (period === "weekly") return start - 7 * DAY;
  return start - DAY;
}

function weighted(bar: FootprintBar): [number, number] {
  return bar.volume > 0 ? [typicalPrice(bar) * bar.volume, bar.volume] : [0, 0];
}

export function calculateVwapSeries(
  bars: readonly FootprintBar[],
  definitions: readonly VwapDefinition[]
): VwapSeries[] {
  return definitions.map((definition) => {
    if (definition.windowMs) return rollingSeries(bars, definition);
    if (definition.family === "previous") return previousSeries(bars, definition);
    return currentSeries(bars, definition);
  });
}

function rollingSeries(bars: readonly FootprintBar[], definition: VwapDefinition): VwapSeries {
  const points: VwapPoint[] = [];
  let left = 0;
  // pv accumulates typicalPrice * volume, which sits around 1e9 for a liquid market --
  // a plain `pv += x` / `pv -= x` running total drifts measurably over a multi-day rolling
  // window because the add and the later subtract don't cancel exactly in float64.
  // addCompensated (Kahan-Neumaier) keeps the drift bounded regardless of series length.
  const pv = createCompensatedSum();
  const volume = createCompensatedSum();
  for (let i = 0; i < bars.length; i++) {
    const [nextPv, nextVolume] = weighted(bars[i]);
    addCompensated(pv, nextPv); addCompensated(volume, nextVolume);
    const cutoff = bars[i].startTime - definition.windowMs!;
    while (left <= i && bars[left].startTime < cutoff) {
      const [oldPv, oldVolume] = weighted(bars[left++]);
      addCompensated(pv, -oldPv); addCompensated(volume, -oldVolume);
    }
    const complete = bars[0]?.startTime <= cutoff;
    points.push({ time: bars[i].startTime, value: complete && volume.sum > 0 ? pv.sum / volume.sum : null });
  }
  return { id: definition.id, points, available: points.some((point) => point.value !== null) };
}

function currentSeries(bars: readonly FootprintBar[], definition: VwapDefinition): VwapSeries {
  const points: VwapPoint[] = [];
  let activeStart = NaN, pv = 0, volume = 0;
  for (const bar of bars) {
    const start = calendarPeriodStart(bar.startTime, definition.period!);
    if (start !== activeStart) { activeStart = start; pv = 0; volume = 0; }
    const [nextPv, nextVolume] = weighted(bar);
    pv += nextPv; volume += nextVolume;
    points.push({ time: bar.startTime, value: volume > 0 ? pv / volume : null });
  }
  return { id: definition.id, points, available: points.some((point) => point.value !== null) };
}

function previousSeries(bars: readonly FootprintBar[], definition: VwapDefinition): VwapSeries {
  const totals = new Map<number, { pv: number; volume: number }>();
  for (const bar of bars) {
    const start = calendarPeriodStart(bar.startTime, definition.period!);
    const total = totals.get(start) ?? { pv: 0, volume: 0 };
    const [pv, volume] = weighted(bar);
    total.pv += pv; total.volume += volume;
    totals.set(start, total);
  }
  const points = bars.map((bar) => {
    const current = calendarPeriodStart(bar.startTime, definition.period!);
    const previous = totals.get(previousPeriodStart(current, definition.period!));
    return { time: bar.startTime, value: previous && previous.volume > 0 ? previous.pv / previous.volume : null };
  });
  return { id: definition.id, points, available: points.some((point) => point.value !== null) };
}
