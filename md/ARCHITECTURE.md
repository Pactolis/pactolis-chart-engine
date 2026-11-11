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

## Render: GpuSurface (WebGPU / WebGL2 / Canvas2D) + Canvas2D, üç surface

`src/core/render/scene/chartScene.ts` üç fiziksel surface tanımlar:

- `gpu-scene` — `GpuSurface` arayüzü arkasında soyutlanmış birincil sahne (`WebGpuSurface`, `WebGl2Surface`, `Canvas2dSurface`; varsayılan ayar `DEFAULT_GPU_SETTINGS.backend = "webgl2"` olup `?gpu=auto|webgpu|webgl2|canvas2d` veya `configureGpuSettingsSource` ile yapılandırılır; `nativeCapture.ts` ise `requestCapture()` veya `getChartWebGl2Context` ile çalışır),
- `annotation` — Canvas2D annotations/drawings and latest-bar HUD (tail-dependent).
- `interaction` — Canvas2D crosshair and pointer controls; fixed-viewport tail updates keep it clean unless the active crosshair selects the changing tail bar.

Render stage → surface eşlemesi `surfaceForStage`, veri güncellemesi → `ChartChange` eşlemesi
`chartChangeForDataUpdate`, değişim kümesi → dirty scope `invalidationScopeForChanges`/
`surfaceDirtyForChanges` ile yapılır. Rendering demand-driven'dır: idle'da sürekli RAF dönmez;
`ChartSession` invalidation bayraklarına göre ilgili surface'leri yeniden çizilir
([tests/chartScene.test.mjs](../tests/chartScene.test.mjs),
[tests/chartSessionSurfaces.test.mjs](../tests/chartSessionSurfaces.test.mjs); browser tarafı için
[tests/browser/chart-invalidation-scope.spec.ts](../tests/browser/chart-invalidation-scope.spec.ts)).

WebGPU arka ucunda `device.lost` veya `uncapturederror` gerçekleştiğinde sistem otomatik olarak `webgl2`
arka ucuna düşer. WebGL context loss durumunda CPU state korunur, GPU state invalidate edilir ve restore
sonrası yeniden kurulur; bağlam geri yükleme zaman aşımına uğrarsa (5 saniye) `replaceSurface` ile
`Canvas2dSurface` yüzeyine düşüş sağlanır ([tests/chartNativeCapture.test.mjs](../tests/chartNativeCapture.test.mjs),
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

## GPU Arka Uç Mimarisi ve Fallback Zinciri (Issue #20)

Motorun fiziksel GPU sahnesi tek bir arayüzün (`GpuSurface`) arkasında soyutlanmıştır:
- `webgpu` — `WebGpuSurface`: WGSL shader'ları, instanced quad boru hattı (`WebGpuQuadPipeline`), paylaşımlı tekil cihaz (`WebGpuDeviceHandle`) ve dokulu ısı haritası (`WebGpuHeatmapLayer`).
- `webgl2` — `WebGl2Surface`: GLSL ES 3.0 tabanlı instanced `QuadBatch` ve `WebGl2HeatmapLayer`.
- `canvas2d` — `Canvas2dSurface`: Başsız veya WebGL/WebGPU desteklemeyen ortamlarda tam işlevsel CPU yedek arka ucu.

### Seçim ve Otomatik Düşüş (Fallback) Zinciri:
Arka uç tercihi yapılandırma veya `?gpu=auto|webgpu|webgl2|canvas2d` URL parametresi ile belirlenir:
1. `webgpu` seçildiğinde sistem `requestWebGpuDevice()` ile cihaz edinmeyi dener; cihaz edinilemezse veya cihaz kaybı (`device.lost`, `uncapturederror`) gerçekleşirse otomatik olarak `webgl2` arka ucuna düşer.
2. `webgl2` kullanılamazsa veya bağlam geri yükleme zaman aşımına uğrarsa (5 saniye) `Canvas2dSurface` yüzeyine düşüş sağlanır (`replaceSurface`).
3. Tüm geçişler, tanılamalar (`GpuDiagnostics`: sayaçlar, p50/p95 kare süreleri, düşüş nedenleri) üzerinden izlenir ve `copyGpuDiagnosticsJson()` ile dışa aktarılabilir.

### WebGPU İmplementasyonunun Mevcut Teknik Sınırları:
- `WebGpuQuadPipeline` ([src/core/gpu/webgpu/webgpuQuadPipeline.ts](../src/core/gpu/webgpu/webgpuQuadPipeline.ts)) `GPUBufferUsage.VERTEX | COPY_DST` instanced vertex buffer kullanır; `RenderPipeline` ve `BindGroup` nesneleri pipeline oluşturulurken bir kez üretilir ve cache'lenir.
- Her flush çağrısında `uploadInstances(...)`, CPU'da biriken `Float32Array` quad verisini 0. offsetten itibaren tam `byteLength` olarak `device.queue.writeBuffer` ile GPU'ya gönderir.
- Mevcut mimaride storage buffer (`GPUBufferUsage.STORAGE`), compute shader veya partial buffer upload bulunmaz; `WebGpuHeatmapLayer` fragment shader texture sampling (`textureSample`) kullanır.

### Performans Telemetrisi ve Sınırları:
- `src/core/performanceTelemetry.ts` ve `src/features/chart/ChartSession.ts` üzerinden 3 yüzey (`gpu-scene`, `annotation`, `interaction`) ve frame render süreleri (`chart.surface.gpu.draw.ms`, `chart.surface.annotation.draw.ms`, `chart.surface.interaction.draw.ms`, `chart.frame.render.ms`) yalnızca CPU tarafında `performance.now()` ile ölçülür.
- Donanım seviyesinde GPU `timestamp-query` (WebGPU) veya `EXT_disjoint_timer_query_webgl2` (WebGL2) ve alt-stage (`gpu-background`, `gpu-series`, `gpu-signal`) zaman kırılımı henüz bulunmamaktadır.
