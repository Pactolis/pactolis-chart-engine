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

`ChartDataSource` implementasyonunun tüm üyeleri [src/features/chart/chartDataSource.ts](../src/features/chart/chartDataSource.ts)
interface'indedir: `streamHistory`/`collectHistory`/`fetchHistory`, open-bar seed için `fetchLiveOhlc`/
`fetchSharedLiveOhlc`, reconnect sonrası trade-gap onarımı için `fetchRepairHistory`, backend rebuild için
`startRefresh`/`fetchRefreshStatus`, candle-only market bildirimi `isDirectCandleMarket` ve açılış
geçmişi uzunluğu `initialHistoryBars`. Sorgu/yanıt şekilleri [src/features/chart/historyContracts.ts](../src/features/chart/historyContracts.ts)'tedir.

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
([ChartRuntime.ts](../src/features/chart/ChartRuntime.ts) :1886-1927). Runtime hazır olana kadar `updateState` çağrısı (örnekteki `runtime` değişkeni bu handle'dır)
pending olarak saklanır: tek bir pending state slotu tutulur ve en son gelen state geçerli olur;
kurulum tamamlanınca yalnız bu en son state uygulanır. Kurulum
tamamlanmadan `dispose()` çağrılırsa eventual olarak kurulmuş runtime dispose edilir.

`ChartRuntimeServices` [src/features/chart/ChartServicePorts.ts](../src/features/chart/ChartServicePorts.ts)'te,
runtime port'ları [src/features/chart/ChartRuntimePorts.ts](../src/features/chart/ChartRuntimePorts.ts)'te
tanımlıdır; mount API'si [src/features/chart/ChartRuntime.ts](../src/features/chart/ChartRuntime.ts)'tedir.
Host mount/dispose sırasında `registerRuntime`/`unregisterRuntime` çağrılarını alır. Yayımlanmış
paket tüketimi örn. `import { mountChartRuntime } from "@pactolis/chart-engine/features/chart/ChartRuntime"`
şeklindedir (paket yolu; repoda karşılığı `src/features/chart/ChartRuntime.ts`).
