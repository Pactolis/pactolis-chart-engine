// Canonical Market Model — saf, yan etkisiz domain modülü.
// String market id ("EXCHANGE:pair") birincil anahtardır ve DEĞİŞMEZ; bu modül
// onu tipli bir görünüme (MarketIdentity) çevirir ve geri üretir. Dağınık
// `market.split(":")` çağrılarının tek kaynağı olmayı hedefler.
//
// Bu modül `dist/domain/market.js` olarak derlenir ve bridge tarafından da yeniden
// kullanılabilir (analysis/* deseni); bu yüzden DOM/Node/Svelte bağımlılığı YOKTUR.

export type Venue = "spot" | "perp" | "future" | "option";

/** String id'den türetilen statik market kimliği. tick/precision gibi RUNTIME
 * metadata buraya konmaz — o, borsa exchangeInfo'sundan gelen ayrı bir katmandır
 * (bkz. `SymbolInfo` in src/data/aggr.ts). */
export interface MarketIdentity {
  id: string;        // "BINANCE_FUTURES:btcusdt" — birincil anahtar, round-trip korunur
  exchange: string;  // "BINANCE_FUTURES"
  symbol: string;    // "BTCUSDT" (upper-normalized)
  venue: Venue;
  base?: string;     // "BTC"  — ayrıştırılabilirse
  quote?: string;    // "USDT" — ayrıştırılabilirse
}

// Bilinen quote varlıkları — en uzun ekten kısaya doğru denenir.
const QUOTE_ASSETS = [
  "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USD",
  "BTC", "ETH", "BNB", "EUR", "TRY", "GBP", "BRL", "JPY",
];

/**
 * "EXCHANGE:pair" → MarketIdentity. Tek parse noktası.
 * id'de ":" yoksa exchange="" kabul edilir, tüm string symbol sayılır.
 */
export function parseMarket(id: string): MarketIdentity {
  const idx = id.indexOf(":");
  const exchange = idx >= 0 ? id.slice(0, idx) : "";
  const rawSymbol = idx >= 0 ? id.slice(idx + 1) : id;
  const symbol = rawSymbol.toUpperCase();
  const venue = classifyVenue(exchange, symbol);
  const { base, quote } = splitBaseQuote(symbol);
  const identity: MarketIdentity = { id, exchange, symbol, venue };
  if (base) identity.base = base;
  if (quote) identity.quote = quote;
  return identity;
}

/**
 * "EXCHANGE:symbol" market venue sınıflandırması.
 * `scripts/bridge/markets.mjs` `classifyMarket`'tan BİREBİR port — parite testiyle
 * korunur (tests/marketModel.test.mjs). Verilen symbol case'i AYNEN işlenir
 * (regex'ler case-sensitive); çağıran casing'i kendi seçer.
 */
export function classifyVenue(exchangeId: string, symbol: string): Venue {
  let type: Venue = "spot";
  if (/[HUZ_-]\d{2}/.test(symbol)) type = "future";
  else if (exchangeId === "BINANCE_FUTURES" || exchangeId === "BITUNIX" || exchangeId === "DYDX" || exchangeId === "HYPERLIQUID") type = "perp";
  else if (exchangeId === "BITFINEX" && /F0$/.test(symbol)) type = "perp";
  else if (exchangeId === "HUOBI" && /_(CW|CQ|NW|NQ)$/.test(symbol)) type = "future";
  else if (exchangeId === "BITMART" && !/_/.test(symbol)) type = "perp";
  else if (exchangeId === "HUOBI" && /-/.test(symbol)) type = "perp";
  else if (exchangeId === "BYBIT" && !/-SPOT$/.test(symbol)) type = /.*[0-9]{2}$/.test(symbol) ? "future" : "perp";
  else if (exchangeId === "BITMEX" || /(-|_)swap$|(-|_|:)perp/i.test(symbol)) type = /\d{2}/.test(symbol) ? "future" : "perp";
  else if (exchangeId === "PHEMEX" && symbol[0] !== "s") type = "perp";
  else if (exchangeId === "KRAKEN" && /_/.test(symbol)) type = "perp";
  else if (exchangeId === "BITGET" && !/-SPOT$/.test(symbol)) type = "perp";
  else if (exchangeId === "KUCOIN" && symbol.indexOf("-") === -1) type = "perp";
  return type;
}

/** "BTCUSDT" → { base:"BTC", quote:"USDT" }. Eşleşmezse ikisi de undefined. */
function splitBaseQuote(symbol: string): { base?: string; quote?: string } {
  // Tireli/altçizgili türev sembollerinde (ör. BTC-PERP, ETH_USDT-SWAP) güvenilir
  // base/quote çıkarmak zor; sade alfasayısal spot/perp sembolleri hedeflenir.
  const clean = symbol.replace(/[^A-Z0-9]/g, "");
  for (const q of QUOTE_ASSETS) {
    if (clean.length > q.length && clean.endsWith(q)) {
      return { base: clean.slice(0, clean.length - q.length), quote: q };
    }
  }
  return {};
}
