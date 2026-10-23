# ARCHITECTURE.md — Chart Engine

`@pactolis/chart-engine`, UI framework/bundler/storage varsayımı olmayan canvas chart motorudur.
Network erişimi yoktur: veri, ayar, metin ve callback'ler host tarafından port'larla verilir
(bkz. [INTEGRATION.md](INTEGRATION.md)).

## Katmanlar

```text
src/
├── core/     framework-bağımsız model, analiz, render primitives ve scene sahipliği
│   ├── engine/view.ts         View/scale/coordinate modeli
│   ├── render/scene/chartScene.ts   surface/stage/invalidation sahipliği
│   └── model/, analysis/, orderbookHeatmap/
└── features/ chart runtime, input, history pipeline, drawings, indicators, orderbook, replay
    └── chart/ChartRuntime.ts  per-panel lifecycle facade
```

`features/chart/ChartRuntime.ts` panel başına bağımsız render/data collaborator'larını kompose eder;
mutasyon içeren state makineleri capability controller'larda yaşar (`ChartSession`, `ChartDataPipeline`,
`ChartHistoryController`, `ChartInputController`, `ChartRenderCoordinator`, `ChartSyncController`).
Fonksiyonel iş birimleri `src/core/` altında tutulur.

## Render: WebGL2 + Canvas2D, üç surface

`src/core/render/scene/chartScene.ts` üç fiziksel surface tanımlar:

- `gpu-scene` — WebGL2 primary scene (`nativeCapture.ts` `getChartWebGl2Context` ile; WebGL1 fallback yoktur),
- `annotation` — Canvas2D annotation/drawing,
- `interaction` — Canvas2D interaction/HUD.

Render stage → surface eşlemesi `surfaceForStage`, veri güncellemesi → `ChartChange` eşlemesi
`chartChangeForDataUpdate`, değişim kümesi → dirty scope `invalidationScopeForChanges`/
`surfaceDirtyForChanges` ile yapılır. Rendering demand-driven'dır: idle'da sürekli RAF dönmez;
`ChartSession` invalidation bayraklarına göre ilgili surface'leri yeniden çizilir
([tests/chartScene.test.mjs](../tests/chartScene.test.mjs),
[tests/chartSessionSurfaces.test.mjs](../tests/chartSessionSurfaces.test.mjs); browser tarafı için
[tests/browser/chart-invalidation-scope.spec.ts](../tests/browser/chart-invalidation-scope.spec.ts)).

WebGL context loss durumunda CPU state korunur, GPU state invalidate edilir ve restore sonrası
yeniden kurulur ([tests/chartNativeCapture.test.mjs](../tests/chartNativeCapture.test.mjs),
[tests/browser/chart-native-capture.spec.ts](../tests/browser/chart-native-capture.spec.ts)).

## Mount/dispose ownership

- `ChartRuntime` yalnız `mountChartRuntime(...)` üzerinden kurulur; `dispose()` tüm timer, listener,
  RAF ve host kaydını geri alır (`chartHost().unregisterRuntime`).
- Host, grafikler arasında tek bir `DrawingManager` paylaşır ve manager en son çizen grafiğin view ile
  zaman eşlemesini tutar; bu eşleme grafiğin serisine ulaşır. `dispose()` bu grafiğin bağlamını
  `releaseHitTestContext(view)` ile bırakır, başka bir grafiğin bağlamına dokunmaz. Aksi halde en son
  kapanan grafik, başka biri çizene kadar bellekte kalır
  ([tests/drawingHitTestContextRelease.test.mjs](../tests/drawingHitTestContextRelease.test.mjs),
  [tests/browser/chart-dispose-drawing-context.spec.ts](../tests/browser/chart-dispose-drawing-context.spec.ts)).
- Port'lar mount'tan önce configure edilmelidir; configure edilmemiş port kullanımı açıkça hata verir
  (örn. `src/features/chart/chartDataSource.ts`).
- Host, runtime lifecycle kaydını `src/features/chart/chartHost.ts` port'u üzerinden alır.
