/**
 * TZ-aware time formatters for chart rendering (overlay.ts, drawTimeAxis).
 * Reads the chart locale's time zone on every call — no reactivity needed since overlay
 * renders every RAF frame anyway.
 */

import { chartLocale } from "./chartLocale.js";

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = chartLocale().locale();
  const tz = chartLocale().timeZone();
  const key = locale + "|" + tz + "|" + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = createFmt(locale, tz, opts);
    fmtCache.set(key, f);
  }
  return f;
}

/** A time zone Intl rejects (edited by hand, left by an old build) formats as UTC instead of throwing. */
function createFmt(locale: string, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts });
  }
}

/** Format as HH:MM in current timezone. */
export function tzHM(ms: number): string {
  return getFmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
}

/** Format as "DD Mon" (e.g. "21 Jun") in current timezone. */
export function tzDay(ms: number): string {
  return getFmt({ day: "2-digit", month: "short" }).format(ms);
}


/** Format as short month name (e.g. "Jun") in current timezone. */
export function tzMonth(ms: number): string {
  return getFmt({ month: "short" }).format(ms);
}

/** Format as four-digit year in current timezone. */
export function tzYear(ms: number): string {
  return getFmt({ year: "numeric" }).format(ms);
}

/** Get individual date parts for boundary detection. */
export function tzParts(ms: number): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = getFmt({
    year: "numeric", month: "2-digit", day: "2-digit",
    // hourCycle h23, not hour12:false: some engines render midnight as "24" with the latter.
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Format for HUD overlay (date + time). */
export function tzDateTimeHud(ms: number, intervalMs: number): string {
  const d = tzParts(ms);
  const date = `${d.day} ${getFmt({ month: "short" }).format(ms)} ${d.year}`;
  if (intervalMs >= 24 * 60 * 60_000) return date;
  return `${date} ${d.hour}:${d.minute}`;
}
