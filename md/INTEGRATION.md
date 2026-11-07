# INTEGRATION.md — Host entegrasyonu

Engine'in network erişimi ve kalıcı state'i yoktur; ihtiyacı olan her şey port'lardan gelir ve
mount'tan **önce** configure edilmelidir.

## Port'lar ve gerçek gereklilikleri

| Configure fonksiyonu | Modül | Zorunluluk |
|---|---|---|
| `configureChartDataSource` | [src/features/chart/chartDataSource.ts](../src/features/chart/chartDataSource.ts) | Mount'tan önce zorunlu; configure edilmezse ilk chart mount hata verir |
| `configureChartHost` | [src/features/chart/chartHost.ts](../src/features/chart/chartHost.ts) | Mount'tan önce zorunlu; runtime kaydı ve chart-type hafızası buraya gider |
| `configureChartLocale` | [src/core/chartLocale.ts](../src/core/chartLocale.ts) | Mount'tan önce zorunlu; locale/time zone/çeviri |
| `configureIndicatorDataSource` | [src/features/indicators/indicatorDataSource.ts](../src/features/indicators/indicatorDataSource.ts) | İndikatörler ek veri istiyorsa zorunlu |
| `configureOrderbookHeatmapSettingsSource` | [src/features/orderbook/heatmapSettingsSource.ts](../src/features/orderbook/heatmapSettingsSource.ts) | Orderbook heatmap kullanılıyorsa zorunlu |
| `configureFootprintBootstrapMarkets` | [src/core/syncAllowlist.ts](../src/core/syncAllowlist.ts) | İsteğe bağlı; footprint varsayımı |
| `configurePerformanceTelemetry` | [src/core/performanceTelemetry.ts](../src/core/performanceTelemetry.ts) | İsteğe bağlı opt-in telemetri: `{ enabled: boolean }` ile açılır, ölçümler in-memory tutulur ve `snapshotPerformanceTelemetry()` ile snapshot olarak okunur; callback/sink API'si yoktur |
| `configureGpuSettingsSource` | [src/core/gpu/gpuSettings.ts](../src/core/gpu/gpuSettings.ts) | İsteğe bağlı; GPU arka uç tercihi (`auto`/`webgpu`/`webgl2`/`canvas2d`), `residentHeatmap` ve `asyncCapture` yönetimi |

`ChartDataSource` implementasyonunun tüm üyeleri [src/features/chart/chartDataSource.ts](../src/features/chart/chartDataSource.ts)
interface'indedir: `streamHistory`/`collectHistory`/`fetchHistory`, open-bar seed için `fetchLiveOhlc`/
`fetchSharedLiveOhlc`, reconnect sonrası trade-gap onarımı için `fetchRepairHistory`, backend rebuild için
`startRefresh`/`fetchRefreshStatus`, candle-only market bildirimi `isDirectCandleMarket` ve açılış
geçmişi uzunluğu `initialHistoryBars`. Sorgu/yanıt şekilleri [src/features/chart/historyContracts.ts](../src/features/chart/historyContracts.ts)'tedir.

## Ekrana uyarlama: `ChartHost.displayOptions`

Host isteğe bağlı olarak `displayOptions(): ChartDisplayOptions` ile grafiğin çalıştığı ekrana uyarlanmasını ister
([chartDisplayOptions.ts](../src/core/model/chartDisplayOptions.ts); alanlar yazılmadıkça masaüstü varsayılanları
geçerlidir, yani bu üye hiç tanımlanmayan bir host seçenekler eklenmeden önceki davranışın aynısını alır).
Seçenekler grafik mount olurken okunur; host durumu değiştirdiğinde (telefon döndü, pencere sınıf değiştirdi)
mount edilmiş her runtime'da `runtime.refreshDisplayOptions()` çağrılır. Geçersiz bir alan yalnız kendi
varsayılanına döner, diğer alanlar korunur.

| Alan | Varsayılan | Etkisi | Mount edilmiş grafikte |
|---|---|---|---|
| `density` | `regular` | `compact`: zaman ekseni şeridi 22 → 32 px (etiketler şeritte ortalı kalır), canlı fiyat etiketi "Price" başlığını bırakıp fiyat eksenini kaplar | `refreshDisplayOptions()` yeniden yerleşim yapar; zoom ve konum oynamaz |
| `priceAxisWidth`, `timeAxisHeight` | 62 / 22 (`compact`: 62 / 32) | Eksen boyutları (CSS px); yoğunluğun değerini tek tek ezer | aynı |
| `labels` | İngilizce (`Trades`, `Range`, `Chg`, `Vol`, `Price`) | HUD alan başlıklarını kısmi olarak değiştirir; belirtilmeyen başlıklar İngilizce kalır | `refreshDisplayOptions()` sonraki çizimde uygular |
| `numberLocale` | `en-US` | HUD sayıları, fiyat ekseni tick'leri, canlı fiyat marker'ı ve crosshair fiyatını BCP 47 locale ile biçimler; geçersiz locale `en-US`'a döner ve varsayılan hassasiyet korunur | `refreshDisplayOptions()` sonraki çizimde uygular |
| `defaultFitColumns` | 250 | İlk ve reset yatay sığdırmanın hedeflediği sütun sayısı (dar plotta daha az sütun, daha okunur mum) | Yalnız sonraki sığdırma/reset'i etkiler; açık grafiğin zoom'u kendiliğinden değişmez |
| `maxDevicePixelRatio` | yok (pencerenin `devicePixelRatio`'su) | Üç canvas'ın, footprint ve heatmap çizicilerinin kullandığı en yüksek piksel oranı (≥ 1); düşük sınır keskinlik yerine GPU belleği ve dolgu hızı kazandırır | Sonraki frame'de canvas'lar yeniden boyutlanır |
| `antialias`, `powerPreference` | `true`, `default` | WebGL2 / WebGPU donanım özniteliği | Yalnız mount: context ilk `getContext` çağrısında sabitlenir, açık grafik değişmez; WebGPU cihaz seçiminde (`requestWebGpuDevice`) `powerPreference` kullanılır; sonradan mount edilenler yeni değeri alır |

Bar özeti (O/H/L/C, Vol, Δ, Trades, Range, Chg) plotun genişliğine sığmıyorsa yoğunluktan bağımsız olarak
satırlara sarılır ([hudLayout.ts](../src/core/render/hudLayout.ts); plot ≥ 400 px yüksekse en çok 3 satır,
≥ 220 px ise 2, daha kısa panelde 1). Satırlara da sığmıyorsa sırayla Range, Trades, Δ, Vol, Chg bırakılır;
O/H/L/C hiç bırakılmaz. Dokunma modunda `⋯` düğmesinin sütunu (`TOUCH_MENU_BUTTON_RESERVE`, 50 px) özetin
genişliğinden düşülür. Dokunma modunda `O`/`L` düğmelerinin kapladığı aralıktaki fiyat etiketleri çizilmez.

Telemetri açıkken (`configurePerformanceTelemetry({ enabled: true })`) WebGL bağlamı için üç sayaç tutulur:
`chart.gpu.contextLost` (bağlam kaybı), `chart.gpu.contextRestored` (geri gelip kullanılabilir oldu) ve
`chart.gpu.contextCreateFailed` (`getContext("webgl2")` mount'ta ya da geri gelirken null döndü; telefonun bağlam
sınırına çarpan bir mount `canvas contexts unavailable` ile başarısız olur ve yüzey modeli `failed` olur).
Davranışı değiştirmezler; telefonda `?perf` ile gerçek cihaz ölçümünün okuduğu değerlerdir.

Harness bu seçenekleri URL'den okur: `?density=compact&fit=70&axisw=62&axish=32&dprcap=2&antialias=0&power=low-power`
([harness/chart.ts](../harness/chart.ts)); `setDisplayOptions(...)` aynı cevabı çalışırken değiştirir.

## GPU diagnostics feature paths

The diagnostics snapshot `featurePaths` reports the active path for enabled features. `featurePaths["orderbook-heatmap"]` is `"webgl2"` after a successful WebGL2 heatmap GPU frame and `"cpu"` while CPU rendering is active, including enabled WebGPU/Canvas2D operation and pending/failed GPU rendering. The key is absent (`undefined`) only while the heatmap feature is disabled or unregistered. Consumers (including FE/#703) should rely on these stable values rather than infer the path from the global backend.

## Generic host mount/dispose wiring (minimal)

```ts
configureChartDataSource(mySource);
configureChartHost(myHost);
configureChartLocale(myLocale);

const runtime = mountChartRuntime(
  panelRoot, panelState, myChartRuntimeServices, panelId, surfaceModel,
  (next) => persist(next),
);
// ...
runtime.updateState(nextState);
runtime.dispose(); // tüm listener/timer/RAF ve host kaydını geri alır
```

`mountChartRuntime` senkron olarak `ChartMountHandle` döndürür; gerçek kurulum asenkrondur
([ChartRuntime.ts](../src/features/chart/ChartRuntime.ts) :2032-2074). Runtime hazır olana kadar `updateState` çağrısı (örnekteki `runtime` değişkeni bu handle'dır)
pending olarak saklanır: tek bir pending state slotu tutulur ve en son gelen state geçerli olur;
kurulum tamamlanınca yalnız bu en son state uygulanır. Kurulum
tamamlanmadan `dispose()` çağrılırsa eventual olarak kurulmuş runtime dispose edilir.

`ChartRuntimeServices` [src/features/chart/ChartServicePorts.ts](../src/features/chart/ChartServicePorts.ts)'te,
runtime port'ları [src/features/chart/ChartRuntimePorts.ts](../src/features/chart/ChartRuntimePorts.ts)'te
tanımlıdır; mount API'si [src/features/chart/ChartRuntime.ts](../src/features/chart/ChartRuntime.ts)'tedir.
Host mount/dispose sırasında `registerRuntime`/`unregisterRuntime` çağrılarını alır. Yayımlanmış
paket tüketimi örn. `import { mountChartRuntime } from "@pactolis/chart-engine/features/chart/ChartRuntime"`
şeklindedir (paket yolu; repoda karşılığı `src/features/chart/ChartRuntime.ts`).
