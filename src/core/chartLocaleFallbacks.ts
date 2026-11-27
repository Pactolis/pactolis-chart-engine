import { chartLocale } from "./chartLocale.js";

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
  "indicator.whaleVsCrowd.warmingBadge": {
    tr: "{venue}: ısınıyor ({days}/{target} gün)",
    en: "{venue}: warming ({days}/{target}d)",
  },
  "indicator.whaleVsCrowd.hlCrowdUnavailable": {
    tr: "Hyperliquid kalabalık verisi yok",
    en: "Hyperliquid crowd data unavailable",
  },
  "indicator.whaleVsCrowd.venueUnsupported": {
    tr: "{venue}: desteklenmiyor",
    en: "{venue}: unsupported",
  },
  "indicator.whaleVsCrowd.venueUnavailable": {
    tr: "{venue}: veri yok",
    en: "{venue}: unavailable",
  },
  "indicator.whaleVsCrowd.venueDisabled": {
    tr: "{venue}: devre dışı",
    en: "{venue}: disabled",
  },
  "indicator.whaleVsCrowd.noData": {
    tr: "Balina/Kalabalık verisi yok",
    en: "No Whale vs Crowd data",
  },
  "indicator.whaleVsCrowd.sourceUnsupported": {
    tr: "Balina/Kalabalık veri kaynağı desteklenmiyor",
    en: "Whale vs Crowd data source unsupported",
  },
  "orderbook.heatmap.browserLiveSource": {
    tr: "uygulama açıldığından beri",
    en: "since app opened",
  },
  "indicator.liveTradeBubbles.trade": {
    tr: "İşlem",
    en: "Trade",
  },
  "indicator.liveTradeBubbles.liquidation": {
    tr: "Likidasyon",
    en: "Liquidation",
  },
  "indicator.liveTradeBubbles.sampled": {
    tr: "örneklenmiş",
    en: "sampled",
  },
  "indicator.liveTradeBubbles.kindsDescription": {
    tr: "Binance likidasyonları 1/sn örneklenir; Hyperliquid herkese açık likidasyon akışı sunmaz.",
    en: "Binance liquidations are 1/s sampled; Hyperliquid lacks a public liquidation stream.",
  },
  "indicator.liveTradeBubbles.unsupported": {
    tr: "Canlı işlem/likidasyon akışı yapılandırılmadı",
    en: "Live trade/liquidation stream is not configured",
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
  "indicator.liquidationProfile.source": {
    tr: "Kaynak",
    en: "Source",
  },
  "indicator.liquidationProfile.source.auto": {
    tr: "Otomatik",
    en: "Auto",
  },
  "indicator.liquidationProfile.source.hyperliquid": {
    tr: "Hyperliquid",
    en: "Hyperliquid",
  },
  "indicator.liquidationProfile.source.model": {
    tr: "Model (Binance)",
    en: "Model (Binance)",
  },
  "indicator.liquidationProfile.showUnverifiedModel": {
    tr: "Doğrulanmamış modeli yine de göster",
    en: "Show unverified model anyway",
  },
  "indicator.liquidationProfile.badgeHyperliquidSource": {
    tr: "Hyperliquid · gerçek pozisyon",
    en: "Hyperliquid · real positions",
  },
  "indicator.liquidationProfile.badgeModelSource": {
    tr: "Model · tahmini · Binance",
    en: "Model · estimated · Binance",
  },
  "indicator.liquidationProfile.warming": {
    tr: "Model ısınıyor",
    en: "Model warming up",
  },
  "indicator.liquidationProfile.modelStale": {
    tr: "Model verisi eski (>30 gün)",
    en: "Model state stale (>30d)",
  },
  "indicator.liquidationProfile.seamMismatch": {
    tr: "Model seam uyuşmazlığı",
    en: "Model seam mismatch",
  },
  "indicator.liquidationProfile.modelUnverified": {
    tr: "Model bu paritede doğrulanmadı",
    en: "Model not verified on this pair",
  },
  "indicator.liquidationProfile.modelUnsupported": {
    tr: "Bu market desteklenmiyor",
    en: "Market not supported by model",
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
  "indicator.crossExchangeOpenInterest.noDataInRange": {
    tr: "Bu aralıkta OI verisi yok",
    en: "No OI data in this range",
  },
  "indicator.crossExchangeOpenInterest.noDataInRangeSince": {
    tr: "Bu aralıkta OI verisi yok · {started}",
    en: "No OI data in this range · {started}",
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
  "indicator.volumeProfile.metric.oiDelta": {
    tr: "OI Delta",
    en: "OI Delta",
  },
  "indicator.volumeProfile.oiDeltaDisplay": {
    tr: "OI Delta Görünümü",
    en: "OI Delta Display",
  },
  "indicator.volumeProfile.oiDeltaDisplay.net": {
    tr: "Net",
    en: "Net",
  },
  "indicator.volumeProfile.oiDeltaDisplay.split": {
    tr: "Açılış / Kapanış",
    en: "Opened / Closed",
  },
  "indicator.volumeProfile.oiVenues": {
    tr: "OI Borsaları",
    en: "OI Venues",
  },
  "indicator.volumeProfile.oiNoData": {
    tr: "OI verisi yok",
    en: "No OI data",
  },
  "indicator.volumeProfile.oiLoading": {
    tr: "OI yükleniyor...",
    en: "Loading OI...",
  },
  "indicator.volumeProfile.oiEstimated": {
    tr: "tahmini",
    en: "estimated",
  },
  "indicator.volumeProfile.oiCoverage": {
    tr: "kapsama %{percent}",
    en: "coverage {percent}%",
  },
  "indicator.volumeProfile.oiRecordingSince": {
    tr: "OI kaydı {time}'dan beri · kapsama %{percent}",
    en: "OI recorded since {time} · coverage {percent}%",
  },
};

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
