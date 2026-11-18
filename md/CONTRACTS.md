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
   ([ChartDataPipeline.ts](../src/features/chart/ChartDataPipeline.ts) :640 / :838 / :882 / :955 / :1067),
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

## Fixed-range volume profile kaynak ve coverage davranışı

Kaynak: [rangeProfile.ts](../src/core/analysis/rangeProfile.ts),
[analysisDrawings.ts](../src/core/render/analysisDrawings.ts),
[orderFlowProfile.ts](../src/core/analysis/orderFlowProfile.ts).

- Seçili bardaki `cells.size > 0`, o bar için exact footprint coverage sayılır. `coverage`, seçili
  barların kaçının exact hücresi bulunduğunu (`coveredBars / totalBars`) bildirir; `complete`, boş
  olmayan seçimin her barında exact hücre olduğu zaman true'dur. `missingDays`, hücresi olmayan
  seçili barların takvim günlerini listeler.
- Fixed Range çiziminde yalnız `coverage === 1` exact hesaplamaya gider; mevcut footprint hücreleri,
  metric, yön ve seviyeler değiştirilmeden kullanılır. En az bir seçili barın hücresi yoksa tüm aralık
  OHLCV fallback'iyle yeniden hesaplanır: hesaplayıcıya verilen kopyalarda bütün `cells` map'leri
  boşaltılır. Böylece partial exact hücrelerle tahmini hacim aynı histogramda hiçbir zaman karışmaz.
- OHLCV fallback yalnız `volume` / `total` için kullanılabilir. Delta, buy/sell, trade count ve average
  trade size seçimleri `availability: "unavailable"` ve `unavailableReason: "exact-footprint-required"`
  döndürür; tahmini hacim bu metriklere aktarılmaz. Tahmini kaynakta `capabilities.metrics` ve
  `capabilities.sides`, kullanılabilen `volume` / `total` seçimi dışındaki ayarları false bildirir.
  `volume` / `total` tahmini sonucu `availability: "available"` taşır. Bu alanlar hem Order Flow
  Profile indikatör snapshot'ında (`profile`) hem Fixed Range çizim snapshot'ında (`profile`) bulunur;
  kullanıcıya gösterilen unavailable nedeni aktif chart locale'inde yerelleştirilir. Exact kaynakta
  yeni availability/capability alanları eklenmez. Estimator yalnız seçili aralığın zaten chart
  serisinde bulunan mumlarını okur; history isteği, backfill veya abonelik açmaz.
- Sonuçtaki `provenance` / `isEstimated`, profildeki kaynak türünü gösterir. `coverage` exact footprint
  kapsamını, `dataComplete` ise hesaplanan metriğin geçerliliğini anlatır; estimate'in exact veri
  olduğunu belirtmez. Çizim etiketi ile Fixed Range analysis snapshot/tooltip, `Estimated (OHLCV)` /
  `Tahmini (OHLCV)` kaynağını aktif chart locale'iyle görünür kılar; tamamen exact sonuçların snapshot
  alanları değişmez.

## GPU loss counters

`gpu.device.lost` counts each lost shared WebGPU device once. `chart.gpu.contextLost`
counts affected chart contexts once per loss; losing one device used by four charts
therefore produces 1 device event and 4 chart events. Both diagnostics and performance
telemetry use the same event writers in [gpuDiagnostics.ts](../src/core/gpu/gpuDiagnostics.ts).
WebGL context events are chart events; they do not increment the WebGPU device counter.

Live repair retains at least 90 seconds of trade references up to a hard cap of
200,000 entries (10,000 minimum at low rates). Four immediate overflow resyncs
are followed by the transport retry ladder, retaining the original gap start.
While deferred, live cells resume and data stays degraded until an authoritative
snapshot repairs the gap. `pipeline.repair.buffer_high_water` reports the aggregate
high-water entries and `pipeline.repair.overflow_deferred` counts deferred overflows.
The independent live flush queue keeps its existing bound; it is not a history journal.
