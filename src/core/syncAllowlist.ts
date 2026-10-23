import type { ChartType } from "./chartPanelState.js";

/**
 * Footprint allowlist — sunucu otorite; host'un verdiği önyükleme listesi yalnızca
 * ilk cevaba kadar geçerlidir.
 *
 * Her `/history` cevabı ilgili market için `meta.footprint.allowed` taşıyor; o cevap
 * geldiği an sunucunun söylediği geçerli olur. Önyükleme listesini host uygulama
 * `configureFootprintBootstrapMarkets` ile verir; verilmezse boştur.
 */
let bootstrapMarkets: ReadonlySet<string> = new Set();

export function configureFootprintBootstrapMarkets(markets: Iterable<string>): void {
  bootstrapMarkets = new Set([...markets].map(normalizeMarket));
}

/**
 * Sunucunun market başına bildirdiği footprint desteği (`meta.footprint.allowed`).
 * Önyükleme listesini geçersiz kılar, çünkü tek yetkili kaynak odur.
 */
const serverReported = new Map<string, boolean>();
type FootprintSupportListener = (market: string, allowed: boolean) => void;
const supportListeners = new Set<FootprintSupportListener>();

/**
 * Bir `/history` cevabındaki `meta.footprint.allowed` değerini kaydeder.
 *
 * `allowed` tanımsızsa (ör. `includeFootprint=0` istendiğinde `meta.footprint` hiç
 * gelmez) kayıt değişmez: cevabın sessizliği "izin yok" demek değildir.
 */
export function recordFootprintSupport(market: string, allowed: boolean | undefined): void {
  if (typeof allowed !== "boolean") return;
  const normalized = normalizeMarket(market);
  if (serverReported.get(normalized) === allowed) return;
  serverReported.set(normalized, allowed);
  for (const listener of supportListeners) listener(normalized, allowed);
}

export function subscribeFootprintSupport(listener: FootprintSupportListener): () => void {
  supportListeners.add(listener);
  return () => supportListeners.delete(listener);
}

/**
 * Sunucunun bu market için açıkça bildirdiği footprint desteği.
 * `undefined`, henüz sunucu otoritesi öğrenilmedi demektir; bu durum desteklenmiyor
 * olarak yorumlanmamalıdır.
 */
export function getFootprintSupport(market: string): boolean | undefined {
  return serverReported.get(normalizeMarket(market));
}

/** Yalnızca testler için: sunucudan öğrenilenleri sıfırlar. */
export function resetFootprintSupport(): void {
  serverReported.clear();
}

// A footprint series asks for its market's support on every live trade, always with the same
// string; remembering the last answer spares the strings the normalization builds each time.
let lastNormalizedInput = "";
let lastNormalizedOutput = "";

/**
 * Market id'sinin kanonik hâli: borsa büyük, sembol küçük harf.
 *
 * Allowlist tam eşleşmeyle aranıyor; bu yüzden `/symbolinfo` ve bazı UI yollarının
 * ürettiği "BINANCE_FUTURES:BTCUSDT" biçimi, adlandırdığı marketten farklı bir market
 * gibi reddediliyordu. Rust tarafındaki `normalize_market` ile aynı davranış.
 */
export function normalizeMarket(market: string): string {
  if (market === lastNormalizedInput) return lastNormalizedOutput;
  const trimmed = market.trim();
  const separator = trimmed.indexOf(":");
  const normalized = separator < 0
    ? trimmed.toLowerCase()
    : `${trimmed.slice(0, separator).toUpperCase()}:${trimmed.slice(separator + 1).toLowerCase()}`;
  lastNormalizedInput = market;
  lastNormalizedOutput = normalized;
  return normalized;
}

/**
 * Verilen market için footprint izinli mi?
 * Market formatı: "EXCHANGE:symbol" (örn. "BINANCE_FUTURES:btcusdt")
 *
 * Sunucu bu market için bir şey söylediyse o geçerlidir; söylemediyse önyükleme
 * listesine bakılır. Yanlış tarafa düşmenin bedeli asimetrik: sunucu zaten kapıyı
 * tutuyor, dolayısıyla eskimiş bir "izinli" en fazla reddedilecek bir istek üretir,
 * eskimiş bir "izinsiz" ise gerçekten desteklenen bir markette UI'yı sessizce kapatır.
 */
export function isFootprintSyncAllowed(market: string): boolean {
  const normalized = normalizeMarket(market);
  return serverReported.get(normalized) ?? bootstrapMarkets.has(normalized);
}

/**
 * İzinli market listesini döndürür (UI listeleme için).
 *
 * Sunucu tüm listeyi tek seferde bildirmiyor — market başına bildiriyor — bu yüzden
 * burada önyükleme listesi, sunucudan öğrenilen farklarla düzeltilerek verilir.
 */
export function getAllowedFootprintSyncMarkets(): readonly string[] {
  const markets = new Set(bootstrapMarkets);
  for (const [market, allowed] of serverReported) {
    if (allowed) markets.add(market);
    else markets.delete(market);
  }
  return [...markets];
}


/**
 * Footprint allowlist dışında kalan bir marketin chart görünümü mum grafiğine
 * kilitlenir. Bu kontrol UI seçicisinden bağımsızdır; persisted state, link-group
 * veya elle dispatch edilen bir chart-type değişikliği de aynı kurala tabidir.
 */
export function constrainChartTypeForMarket(market: string, requested: ChartType): ChartType {
  return isFootprintSyncAllowed(market) ? requested : "candlestick";
}

/**
 * Kalıcı state'e yazılacak grafik tipi.
 *
 * Sunucu bir market için henüz konuşmadıysa `constrainChartTypeForMarket` önyükleme
 * listesine düşer ve listede olmayan (ör. operatörün sonradan eklediği)
 * marketleri geçici olarak mum grafiğine kilitler. O geçici kilit kullanıcının seçimi
 * değildir; kaydedilirse sayfa yenilendiğinde footprint seçimi kaybolur. Bu yüzden
 * seçim yalnızca sunucu bu market için footprint'i açıkça kapattığında mum grafiğine
 * indirilir.
 */
export function persistableChartTypeForMarket(market: string, requested: ChartType): ChartType {
  return getFootprintSupport(market) === false ? "candlestick" : requested;
}
