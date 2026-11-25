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
  "indicator.volumeProfile.placement": {
    tr: "Yerleşim",
    en: "Placement",
  },
  "indicator.volumeProfile.placement.left": {
    tr: "Sol",
    en: "Left",
  },
  "indicator.volumeProfile.placement.right": {
    tr: "Sağ",
    en: "Right",
  },
  "draw.fixedRangeVolumeProfile.placement": {
    tr: "Profil Yerleşimi",
    en: "Profile Placement",
  },
  "draw.fixedRangeVolumeProfile.placement.left": {
    tr: "Aralık Başlangıcı (Sol)",
    en: "Range Start (Left)",
  },
  "draw.fixedRangeVolumeProfile.placement.right": {
    tr: "Aralık Sonu (Sağ)",
    en: "Range End (Right)",
  },
  "indicator.liquidationProfile.badge": {
    tr: "Hyperliquid · snapshot {minutes} dk önce · tahmini",
    en: "Hyperliquid · snapshot {minutes} min ago · estimated",
  },
  "indicator.liquidationProfile.badgeNow": {
    tr: "Hyperliquid · şimdi · tahmini",
    en: "Hyperliquid · just now · estimated",
  },
  "indicator.liquidationProfile.unsupported": {
    tr: "Hyperliquid'de bu market yok",
    en: "Market unavailable on Hyperliquid",
  },
  "indicator.liquidationProfile.unavailable": {
    tr: "Likidasyon verisi yok",
    en: "No liquidation data",
  },
  "indicator.liquidationProfile.hlPriceStale": {
    tr: "HL fiyatı eski",
    en: "HL price stale",
  },
  "indicator.liquidationProfile.priceDivergence": {
    tr: "HL/Binance fiyat farkı >%1",
    en: "HL/Binance price divergence >1%",
  },
  "indicator.liquidationProfile.densityNote": {
    tr: "bekleyen tahmini likidasyon yoğunluğu",
    en: "estimated pending liquidation density",
  },
  "indicator.liquidationProfile.rangePct": {
    tr: "Fiyat Aralığı",
    en: "Price Range",
  },
  "indicator.liquidationProfile.rangeAll": {
    tr: "Tümü",
    en: "All",
  },
  "indicator.liquidationProfile.minNotionalUsd": {
    tr: "Min. Hacim (USD)",
    en: "Min Notional (USD)",
  },
  "indicator.liquidationProfile.profileWidth": {
    tr: "Genişlik",
    en: "Width",
  },
  "indicator.liquidationProfile.opacity": {
    tr: "Opaklık",
    en: "Opacity",
  },
  "indicator.liquidationProfile.showCumulative": {
    tr: "Kümülatif Eğri",
    en: "Cumulative Curve",
  },
  "indicator.liquidationProfile.longColor": {
    tr: "Long Likidasyon Rengi",
    en: "Long Liquidation Color",
  },
  "indicator.liquidationProfile.shortColor": {
    tr: "Short Likidasyon Rengi",
    en: "Short Liquidation Color",
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
