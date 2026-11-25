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

const CHART_LOCALE_FALLBACKS: Readonly<Record<string, { tr: string; en: string }>> = {
  "analysis.tpo.partial": {
    tr: "Kısmi",
    en: "Partial",
  },
  "indicator.volumeProfile.estimated": {
    tr: "Tahmini (OHLCV)",
    en: "Estimated (OHLCV)",
  },
  "indicator.volumeProfile.estimatedShort": {
    tr: "Tahmini",
    en: "Estimated",
  },
  "indicator.volumeProfile.mixed": {
    tr: "Tahmini (Karma)",
    en: "Estimated (Mixed)",
  },
  "indicator.volumeProfile.estimatedMetricUnsupported": {
    tr: "Kullanılamıyor: gerçek footprint verisi gerekir",
    en: "Unavailable: exact footprint data required",
  },
  "indicator.common.unit": {
    tr: "Birim",
    en: "Unit",
  },
  "indicator.crossExchangeOpenInterest.unit.usd": {
    tr: "USD",
    en: "USD",
  },
  "indicator.crossExchangeOpenInterest.unit.base": {
    tr: "Base (Coin)",
    en: "Base (Coin)",
  },
  "indicator.crossExchangeOpenInterest.unrecorded": {
    tr: "OI kaydı yok (bu market kaydedilmiyor)",
    en: "No OI record (this market is not recorded)",
  },
  "indicator.crossExchangeOpenInterest.instantOnly": {
    tr: "yalnız anlık",
    en: "instant-only",
  },
  "indicator.crossExchangeOpenInterest.recordingStarted": {
    tr: "Kayıt başlangıcı: {time}",
    en: "Recording started: {time}",
  },
  "indicator.crossExchangeOpenInterest.historyStarted": {
    tr: "Geçmiş başlangıcı: {time}",
    en: "History started: {time}",
  },
};

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

function formatParams(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/**
 * Translates via the host `ChartLocale`, falling back to built-in TR/EN labels when the
 * host catalog has not yet registered a newer optional engine key (or echoes the raw key).
 */
export function tOr(key: string, params?: Record<string, string | number>): string {
  const active = chartLocale();
  const translated = active.translate(key, params);
  if (translated && translated !== key && !translated.startsWith(`${key} `)) {
    return translated;
  }
  const fallback = CHART_LOCALE_FALLBACKS[key];
  if (!fallback) return translated;
  const lang = (active.locale() || "").toLowerCase();
  const text = lang === "tr" || lang.startsWith("tr-") || lang.startsWith("tr_") ? fallback.tr : fallback.en;
  return formatParams(text, params);
}
