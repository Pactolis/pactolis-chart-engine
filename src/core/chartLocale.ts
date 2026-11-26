import type { ChartMessageKey } from "./chartMessageKeys.js";

export type { ChartMessageKey };

/**
 * Language, time zone and translated text for the chart engine. The engine
 * does not own the app's locale or time zone settings or its message catalog;
 * the host application supplies them at startup.
 */
export interface ChartLocale {
  /** BCP 47 tag used for number and date formatting. */
  locale(): string;
  /** IANA time zone for chart times. Formatters fall back to UTC if it is not usable. */
  timeZone(): string;
  /** Translated text for `key`, with `{name}` placeholders filled from `params`. */
  translate(key: string, params?: Record<string, string | number>): string;
  /** Call `listener` after the locale changes. Returns an unsubscribe function. */
  onLocaleChange(listener: () => void): () => void;
}

let configured: ChartLocale | null = null;

export function configureChartLocale(locale: ChartLocale): void {
  configured = locale;
}

export function chartLocale(): ChartLocale {
  if (configured === null) {
    throw new Error("chart locale is not configured; call configureChartLocale() before using the chart engine");
  }
  return configured;
}

/** Shorthand for `chartLocale().translate()`. */
export function t(key: ChartMessageKey, params?: Record<string, string | number>): string;
export function t(key: string, params?: Record<string, string | number>): string;
export function t(key: string, params?: Record<string, string | number>): string {
  return chartLocale().translate(key, params);
}
