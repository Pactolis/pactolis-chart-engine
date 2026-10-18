# CONTRACTS.md — Export yüzeyi ve veri invariants

## Public export yüzeyi

Public API `package.json` `exports` alanıdır; her entry `dist/` altına build edilir ve
`npm run check:exports` (scripts/check-exports.mjs) her entry'nin var olduğunu ve yüklendiğini
doğrular. `exports` listesine entry eklemek/çıkarmak public API değişikliğidir. Engine'in runtime
dependency'si yoktur.

## History / live / repair birim ve veri invariants

Kaynak: [src/features/chart/historyContracts.ts](../src/features/chart/historyContracts.ts),
[src/features/chart/ChartDataPipeline.ts](../src/features/chart/ChartDataPipeline.ts),
[src/core/types.ts](../src/core/types.ts), [src/core/time.ts](../src/core/time.ts),
[src/core/priceStep.ts](../src/core/priceStep.ts).

- **HistoryQuery / HistoryBatch:** `HistoryQuery` market listesi, `from`/`to` (ms epoch bucket
   aralığı), `interval` (**milisaniye**) ve `priceStep` taşır. Birimler source'ta ms'dir:
   pipeline her sorguda `interval: this._intervalMs` gönderir
   ([ChartDataPipeline.ts](../src/features/chart/ChartDataPipeline.ts) :591/:786/:830/:903),
   bucket hesapları `bucketStart`/`bucketEnd` ms parametrelidir
   ([time.ts](../src/core/time.ts)); `AggTrade.time` ve `FootprintBar.startTime` de ms epoch'tur.
   `rebuild`, `includeFootprint`, `preferCache`,
   `candleCoverage: "required"` ve `purpose` isteğin öncelik/kapsam sözleşmesini değiştirir.
   `HistoryBatch.bars` `FootprintBar` listesidir; `sequence` batch sırasını, `cellCount` coalescing
   öncesi hücre sayısını bildirir.
- **Envelope meta:** `onMeta` callback'i `EnvelopeMeta` (`meta.degraded`, `meta.provenance`) taşır;
  pipeline bunu degraded-data sinyaline çevirir, transport katmanı UI framework'üne bağımlı değildir.
- **Live trade stream:** `TradeStreamSession` (`generation`, `epoch`, `session`, `boundaryAt`) canlı
  akış oturumlarını tanımlar; open bar seed `fetchLiveOhlc`/`fetchSharedLiveOhlc` ile yapılır ve
  aynı bar seed'i fiyat değişimlerini izler (`tests/chartHistoryLiveSeed.test.mjs`,
  `tests/chartLiveOhlcSeedPriceChange.test.mjs`).
- **Repair:** `RepairHistoryQuery` reconnect sonrası bir market/aralık için **trade-id-exact** footprint
  okur; repair tamamlanmadan partial footprint alanları assertions'la korunur
  (`tests/chartRepairBoundaries.test.mjs`, `tests/liveRepairRetryPolicy.test.mjs`,
  `tests/footprintRepairSupportRegression.test.mjs`).
- **Revision:** `FootprintBar` üzerinde `cellRevision` bu bar'ın hücreleri değiştiğinde artan
  bar-local bir cache-invalidation sayacıdır; render cache'leri buna anahtarlanır
  ([types.ts](../src/core/types.ts) :84-89). Global değildir, hiçbir zaman serialize edilmez.
  `updatedAt` trade'ten alınan wall clock'tur, aynı ms içinde tekrar edebilir veya geri gidebilir;
  bar otoritesi `completeness`, veri kökeni ise `sources` (`history`/`live`/`recovery`) alanlarıyla
  source'ta doğrudan taşınır.
- **Revision/birlik kuralları:** zaman bucket'ları `src/core/time.ts` (`bucketEnd`), fiyat grid'i
  `src/core/priceStep.ts` ile normalize edilir; repair ve history birimlerinin bu grid'e uyması
  invariant'tır (`tests/priceStep.test.mjs`, `tests/time.test.mjs`,
  `tests/chartHistoryContractGuards.test.mjs`, `tests/chartHistoryFlushInvariant.test.mjs`).

Bu belge invariantları **kaynakta ve testlerde** doğrulanmış haliyle işaret eder; burada listelenmeyen
bir davranış için source'a bakın, bu belgeden davranış çıkarmayın.
