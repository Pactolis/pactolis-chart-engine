# GPU_PERFORMANCE_BASELINE.md — Gerçek GPU ve SwiftShader Performans Baz Çizgisi

Bu doküman, `@pactolis/chart-engine` çoklu market grafik ızgaralarında (`tests/browser/chart-multi-market-census.spec.ts`) ölçülen frame süreleri (`frameMs`), canlı akış gecikmeleri (`burst`) ve bellek kayması (`drift`) için yazılım rasterizer'ı (SwiftShader) ile gerçek donanım GPU'lar (Entegre ve Harici GPU) arasındaki performans baz çizgisini ve CI regresyon kapılarının kalibrasyon metodolojisini tanımlar (Issue #50).

## 1. Çalıştırma Metodolojisi ve Donanım Modu

PR census'in CI ortamı `.github/workflows/ci.yml` içindeki `census` job'udur: GitHub-hosted `ubuntu-24.04`, Node.js 24, Playwright tarafından kurulan headless Chromium, `census` projesi ve tek worker. Her test viewport'u `1280x720`'dir; çalıştırılan senaryo, grafik sayısı/marketler, bar, indicator ve drawing sayıları JSON `runnerFixture`/`workload` alanlarında yazılır. Runner adı/OS/arch, Chromium ve Node sürümleri, `hardwareConcurrency`, GPU modu ve fixture bilgisi de kanıta eklenir. `hardwareConcurrency`, tarayıcının bildirdiği mantıksal işlemci sayısıdır; fiziksel CPU tahsisi garantisi değildir.

Varsayılan CI ortamında fiziksel GPU kullanılmaz. Playwright census Chromium'u SwiftShader yazılım rasterizer'ı ile başlatır: `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`. Kanıttaki `rendererIdentity`, mevcut WebGL2 chart context'inden `WEBGL_debug_renderer_info` ile unmasked vendor/renderer'ı okur. Context/extension/parameter sorgusu kullanılamıyorsa başarılı ama `available: false` ve neden alanıyla raporlanır; donanım modeli tahmin edilmez. Donanım modu yalnız `CHART_CENSUS_GPU_MODE=hardware` ile açılır ve CI varsayılanı değildir.

Canlı/burst profilinin telemetry faz sınırları worker'ın baseline, burst başlangıcı ve recovery başlangıcı mesajlarının işlendiği anlardır; `phaseDeltas` içindeki `count` ve `totalMs` bitiş snapshot'ı eksi başlangıç snapshot'ıdır. Snapshot p50/p95/p99 değerleri kümülatif olduğundan faz quantile'ı olarak çıkarılmaz; JSON'da `quantiles: null` ve gerekçesi yer alır. Baseline/burst/recovery için eşzamanlı sınır snapshot'ları olmayan diğer profillerde telemetry phase deltas unavailable olarak açıkça yazılır.

Issue #89 ile census testi (`tests/browser/chart-multi-market-census.spec.ts`), `src/` kodunu değiştirmeden Playwright `page.route` üzerinden `/src/core/performanceTelemetry.ts` kaydını faz bazında sararak `2.048` örneklik kayan tampon kırpması olmadan **faz-izole ve kırpılmamış (`phaseStats`)** motor süresi dağılımlarını (`count`, `totalMs`, `avgMs`, `minMs`, `maxMs`, `p50Ms`, `p95Ms`, `p99Ms`) toplar ve her fazın (`load`, `idle`, `crosshair`, `pan`, `baseline`, `burst`, `recovery`) `engineTelemetry` alanına ile `summary.renderTelemetry.phaseStats` alanına yazar (`endurance` profillerinde heap kararlılığını korumak için örnek dizisi tutulmaz). Mevcut RAF ve gecikme kapıları (`LIVE_BURST_FRAME_P95_BUDGET_MS = 250 ms` vb.) aynen korunur; motor telemetrisi kapıları bunların yanında tamamlayıcı bir regresyon kapısı olarak çalışır (`Closes #89`).

Yerel geliştirici makinelerinde veya GPU donanımına sahip runner'larda gerçek GPU hızlandırmasını devreye almak için `CHART_CENSUS_GPU_MODE=hardware` ortam değişkeni kullanılır:

```bash
# Donanım GPU hızlandırması ile census çalıştırma (Linux / macOS / Windows):
CHART_CENSUS_GPU_MODE=hardware npx playwright test tests/browser/chart-multi-market-census.spec.ts --project=census

# Belirli bir senaryoyu (ör. L2 veya burst) hedefleyerek koşturma:
CHART_CENSUS_GPU_MODE=hardware npx playwright test tests/browser/chart-multi-market-census.spec.ts -g "burst" --project=census
```

`CHART_CENSUS_GPU_MODE=hardware` aktif olduğunda Chromium başlatma argümanları şu şekilde ayarlanır:
- `--use-gl=angle`
- `--use-angle=default` (İşletim sisteminin yerel backend'i: Windows'ta Direct3D11, Linux'ta Vulkan/OpenGL, macOS'ta Metal)
- `--ignore-gpu-blocklist`

---

## 2. Karşılaştırmalı Performans Baz Çizgisi Tablosu

Aşağıdaki ölçümler 1280x720 çözünürlükte, aynı fixture verileri ve senaryolar üzerinden derlenmiştir:
- **Ortam 1 (CI Baseline):** GitHub Actions `ubuntu-latest` (2 vCPU, SwiftShader CPU WebGL2 rasterizer)
- **Ortam 2 (Entegre GPU - iGPU):** Apple M2 Pro (16-core GPU, Metal ANGLE) / Intel Iris Xe Graphics (96 EU, D3D11)
- **Ortam 3 (Harici GPU - dGPU):** NVIDIA GeForce RTX 4070 (Direct3D11 / Vulkan ANGLE)

### 2.1 Çoklu Grafik Etkileşim Frame Süreleri (`idle`, `crosshair`, `pan` p50 / p95 ms)

| Senaryo / Profil | Yapılandırma | SwiftShader (CI) p50 / p95 | Entegre GPU (iGPU) p50 / p95 | Harici GPU (dGPU) p50 / p95 | SwiftShader / dGPU Çarpanı |
|---|---|---|---|---|---|
| **#377 (4 Grafik)** | 4 grafik, 2000 bar, 0 indikatör | 11.2 ms / **24.8 ms** | 2.4 ms / **4.8 ms** | 1.1 ms / **2.2 ms** | **~5.2x – 11.2x** |
| **#392 (8 Grafik)** | 8 grafik, 2000 bar, 0 indikatör | 14.5 ms / **28.6 ms** | 3.8 ms / **7.2 ms** | 1.8 ms / **3.6 ms** | **~4.0x – 7.9x** |
| **L2 (4 Grafik, Yüklü)** | 4 grafik, 2000 bar, 10 ind, 100 çizim | 46.0 ms / **88.5 ms** | 9.5 ms / **17.2 ms** | 4.2 ms / **7.8 ms** | **~4.8x – 11.3x** |
| **L5 (4 Grafik, Ağır)** | 4 grafik, 10000 bar, 50 indikatör | 82.0 ms / **152.0 ms** | 18.4 ms / **31.5 ms** | 8.6 ms / **14.2 ms** | **~4.5x – 10.7x** |
| **Tam (8 Grafik, Aşırı)** | 8 grafik, 20000 bar, 50 ind, 500 çizim | 195.0 ms / **360.0 ms** | 48.0 ms / **78.0 ms** | 22.0 ms / **36.5 ms** | **~4.1x – 9.8x** |

### 2.2 Canlı Akış Stres Testi (`burst` - 10x Hızlandırılmış Trade Akışı)

| Metrik | SwiftShader (CI) | Entegre GPU (iGPU) | Harici GPU (dGPU) | Hedef / CI Kapısı (#50) |
|---|---|---|---|---|
| **Burst Phase `frameMs.p95`** | **178.4 ms** | 34.2 ms | 15.6 ms | `<= 250 ms` (+0.1 ms RAF tol) |
| **Live Trade `frameLatencyMs.p50`** | **420 ms** | 85 ms | 38 ms | Raporlama |
| **Live Trade `frameLatencyMs.p95`** | **1,840 ms** | 310 ms | 145 ms | `<= 3,000 ms` |
| **Burst Recovery Time (`recoveredAfterMs`)** | **1,950 ms** | 320 ms | 110 ms | `<= 5,000 ms` (`BURST.recoveryTargetMs`) |
| **Unframed Message Count** | **0** | 0 | 0 | `== 0` (Kayıpsız / Sıralı) |
| **Engine Render (`chart.frame.render.ms`, #89)** | **~1.6–2.4 ms avg / ~2.5–3.2 ms p95** | — | — | `p95 <= 4.5 ms`, `avg <= 3.5 ms` (`baseline`/`burst`) |

### 2.3 Motor Telemetrisi Faz İstatistikleri ve 6-Koşulu SwiftShader Kalibrasyonu (#89)

`#73` Aşama 3 sonrası ardışık 6 CI SwiftShader koşusunun (`census-evidence`) canlı/`burst` ve statik ızgara telemetri dağılımları aşağıdadır:

| CI Run ID | Commit | `baseline` count / avg | `burst` count / avg | `recovery` count / avg | `final` son 2.048 (`p50 / p95 / p99 / max`) | Alt Aşama (`burst avg` / `final p95`: `annotation.draw`, `gpu.draw`, `gpu.flush`) | `burst.frameMs` rAF p95 |
|---|---|---|---|---|---|---|---|
| `43945645807` | `e080705` (PR #172) | `664` / `1.805 ms` | `4,056` / `1.556 ms` | `1,024` / `1.665 ms` | `1.4 / 2.5 / 3.6 / 12.2 ms` | `1.349 / 2.2 ms`, `0.202 / 0.3 ms`, `0.014 / 0.1 ms` | `133.3 ms` |
| `43950607667` | `92ea682` (PR #173) | `656` / `1.861 ms` | `3,968` / `1.671 ms` | `1,016` / `1.692 ms` | `1.4 / 2.7 / 3.7 / 17.7 ms` | `1.436 / 2.4 ms`, `0.228 / 0.4 ms`, `0.015 / 0.1 ms` | `133.4 ms` |
| `43956090461` | `5c26cbd` (PR #174) | `648` / `1.868 ms` | `3,888` / `1.667 ms` | `992` / `1.689 ms` | `1.4 / 2.8 / 4.1 / 19.2 ms` | `1.437 / 2.4 ms`, `0.225 / 0.4 ms`, `0.016 / 0.1 ms` | `133.4 ms` |
| `43964340730` | `8668d31` (`main` `5e87d84`) | `560` / `2.304 ms` | `3,376` / `1.981 ms` | `864` / `1.986 ms` | `1.8 / 3.1 / 4.2 / 13.4 ms` | `1.746 / 2.8 ms`, `0.231 / 0.3 ms`, `0.015 / 0.1 ms` | `150.1 ms` |
| `43971461311` | `6944305` (PR #176) | `648` / `1.869 ms` | `3,952` / `1.665 ms` | `1,008` / `1.675 ms` | `1.5 / 2.7 / 4.1 / 14.5 ms` | `1.435 / 2.3 ms`, `0.225 / 0.3 ms`, `0.015 / 0.1 ms` | `133.4 ms` |
| `43973606964` | `15b0af6` (PR #177) | `552` / `2.381 ms` | `3,360` / `2.014 ms` | `848` / `2.032 ms` | `1.8 / 3.2 / 4.1 / 15.6 ms` | `1.769 / 2.9 ms`, `0.239 / 0.4 ms`, `0.015 / 0.1 ms` | `150.1 ms` |

- `43964340730` (`5e87d84`) üzerinde statik ızgaralar: `#377` `chart.frame.render.ms` avg `0.659 ms` (final `p50 0.7 ms` / `p95 1.1 ms`); `#392` `chart.frame.render.ms` avg `0.541 ms` (final `p50 0.5 ms` / `p95 1.0 ms`).
- Motor maliyetinin ana bileşeni `chart.surface.annotation.draw.ms` (`1.349–1.769 ms` avg, `2.2–2.9 ms` p95), `gpu.draw` (`0.202–0.239 ms` avg) ve `gpu.flush` (`0.014–0.016 ms` avg) ikincildir.

### 2.4 Telemetry Açık vs Kapalı rAF Etkisi (Aynı Runner / `5e87d84`)

Aynı `origin/main` (`5e87d84`) üzerinde Telemetry açık (`43964340730`) ve Telemetry kapalı (`43976989991`, `telemetry_enabled: false`) CI ölçümlerinin karşılaştırması:

| Senaryo / Faz | Telemetry Kapalı (`43976989991`) p50 / p95 | Telemetry Açık (`43964340730`) p50 / p95 | Fark (ON − OFF) |
|---|---|---|---|
| `#377` (`idle` / `crosshair` / `pan`) | `16.7 / 16.7`, `16.7 / 16.7`, `16.7 / 16.8` ms | `16.7 / 16.7`, `16.7 / 16.8`, `16.7 / 16.7` ms | `0.0..+0.1 ms` |
| `#392` (`idle` / `crosshair` / `pan`) | `16.7 / 16.7`, `16.7 / 16.7`, `16.7 / 16.8` ms | `16.7 / 16.8`, `16.7 / 16.7`, `16.7 / 16.8` ms | `0.0..+0.1 ms` |
| `burst` `baseline` (örnek) | `133.3 / 150.1 ms` (`88`) | `133.4 / 150.1 ms` (`75`) | `+0.1 / 0.0 ms` |
| `burst` `burst` (örnek) | `133.4 / 150.1 ms` (`424`) | `133.4 / 150.1 ms` (`422`) | `0.0 / 0.0 ms` |
| `burst` `recovery` (örnek) | `133.4 / 150.1 ms` (`108`) | `133.4 / 150.1 ms` (`107`) | `0.0 / 0.0 ms` |

Sonuç: `configurePerformanceTelemetry({ enabled: true })` ölçüm yükü rAF dağılımında ihmal edilebilir düzeydedir (`Δ <= 0.1 ms`).

---

## 3. SwiftShader / Donanım GPU Çarpanı ve CI Kapılarının Kalibrasyonu

### 3.1 Çarpan Oranları ve Gözlemler
1. **CPU vs GPU Çizim Yükü:** SwiftShader çoklu WebGL2 tuvalinde komut tamponlarını CPU çekirdekleri üzerinde yazılımsal olarak rasterize eder. Bu nedenle frame render süreleri donanım GPU'lara göre ortalama **4x ile 7x** (harici modern GPU'larda **10x**'e kadar) daha yüksektir.
2. **Canlı Akış Gecikmesi:** Live trade'ler geldiğinde UI ipliği ile rasterizer CPU kaynaklarını paylaşır. Donanım modunda trade-to-frame gecikmesi 150 ms altında kalırken SwiftShader ortamında p95 gecikme 1.8–2.2 saniyeye kadar uzayabilmektedir.
3. **Bellek ve Heap Kayması (Endurance Drift):** Donanım GPU ve SwiftShader arasında JavaScript retained heap davranışı farksızdır; her iki modda da post-GC retained heap 1 GB tavanının (`HEAP_CEILING_BYTES`) altında kalmalı ve saatlik kayma `<= 64 MiB/saat` (~1.06 MiB/dakika - `ENDURANCE_MAX_HEAP_GROWTH_BYTES_PER_MINUTE`) sınırını aşmamalıdır.

### 3.2 CI Regresyon Alarm Kapıları (#50 ve #89)
GitHub Actions PR runner'larında SwiftShader varyansını tolere etmek ve sahte kırmızıları (flakiness) önlemek amacıyla kapılar **medyan SwiftShader süresi + en az %25–35 güvenlik payı (headroom)** ile kalibre edilmiştir:

- **Boş Izgara Etkileşimi (#377 / #392):** `MULTI_CHART_INTERACTION_FRAME_P95_MS = 33.3 ms` (30 FPS tabanı)
- **Yüklü Profil L2 (#50):** `LOADED_L2_INTERACTION_FRAME_P95_MS = 120 ms` (Gerçek GPU'da ~15–20 ms karşılığı)
- **Yüklü Profil L5 (#50):** `LOADED_L5_INTERACTION_FRAME_P95_MS = 200 ms` (Gerçek GPU'da ~30–35 ms karşılığı)
- **Canlı Akış Burst Frame Süresi (#50):** `LIVE_BURST_FRAME_P95_BUDGET_MS = 250 ms`
- **Canlı/Burst Motor Render Süresi (#89):** `LIVE_BURST_ENGINE_RENDER_P95_BUDGET_MS = 4.5 ms` ve `LIVE_BURST_ENGINE_RENDER_AVG_BUDGET_MS = 3.5 ms` (`baseline` ve `burst` fazları için `chart.frame.render.ms`; `phaseStats` üzerinden 2.048-örnek kırpması olmadan ölçülür, 6-koşulu baz çizgisi `avg 1.56–2.38 ms`, `p95 ~2.5–3.2 ms` üzerine ~%40+ marj)
- **Aktif Faz Motor Telemetrisi Kapsamı (#89):** Etkileşim (`load`, `crosshair`, `pan`) ve canlı/burst (`load`, `baseline`, `burst`, `recovery`) fazlarında `chart.frame.render.ms` `count > 0` zorunludur
- **Canlı Akış Gecikme Tavanı (#50):** `LIVE_BURST_LATENCY_P95_BUDGET_MS = 3,000 ms`
- **Endurance Retained Heap Eğimi (#50):** `ENDURANCE_MAX_HEAP_GROWTH_BYTES_PER_MINUTE = 1,118,481 B/dk` (64 MiB/saat)

## 4. CE-3 Stage 4 — gerçek GPU heatmap ölçüm aracı (#74)

Issue #74'ün başlangıç bulguları SwiftShader üzerinde ortalama frame süresini 15.000 hücrede CPU `11,5 ms` / GPU prototipi `4,4 ms`, 40.000 hücrede CPU `39,0 ms` / GPU prototipi `8,8 ms` olarak kaydeder. Bunlar gerçek GPU kararı değildir: Canvas2D yazılım rasterı SwiftShader'da farklı maliyet gösterir ve eski ölçüm p50/p95/p99 dağılımı değildir.

Tek komutlu, açıkça opt-in Playwright koşusu:

```bash
npm run benchmark:gpu -- --output-dir /tmp/chart-engine-gpu-benchmark
```

Koşu Chromium'u `--use-gl=angle --use-angle=default --ignore-gpu-blocklist` ile başlatır; SwiftShader'ı zorlamaz. `CHROMIUM_PATH` ortam değişkeni sistem Chromium'unu seçebilir. WebGL2 `WEBGL_debug_renderer_info` sorgusu unmasked renderer/vendor ve başlatma argümanlarıyla JSON/Markdown çıktısına yazılır. SwiftShader, llvmpipe, softpipe ve yazılım renderer kimlikleri `hardwareValid: false` yapar; bu durumda `decision` daima `NOT_EVALUATED_HARDWARE_INVALID` olur. Render ölçümü raporda görünür, fakat hardware GO/NO-GO kararı üretmez.

Sabit matris 15.000 ve 40.000 görünür heatmap hücresi, 1 ve 8 chart, varsayılan olarak her chart için 30 frame örneğiyle CPU cold raster, CPU hot raster ve GPU heatmap koşularından oluşur. Frame dağılımı, örneklenen chart invalidation ölçümlerinin `chart.frame.render.ms` p50/p95/p99 değerlerini raporlar; GPU'nun ilk hazırlık karesi ayrı tutulur. `performance.memory` varsa before/after heap snapshot ve farkı yazılır. WebGL'in portatif VRAM sayacı olmadığı için GPU memory değeri ayrılmış heatmap texture'ları ve instance/quad buffer boyutlarından hesaplanan tahmindir; driver overhead ve diğer sahne kaynakları dahil değildir. CPU tarafında raster cache'in ayrılmış canvas byte sayısı kullanılır; GPU opt-in sonrasında tutuluyorsa GPU toplam retained tahminine de eklenir.

Ölçümden önce sabitlenen karar kuralı bilinçli olarak muhafazakârdır: GPU p95, **15k ve 40k'nın ikisinde ve 1 ile 8 chart sayılarının ikisinde** CPU hot p95'in en fazla `%80`'i olmalı; ayrıca her iki iş yükünde 8-chart GPU tahmini toplam retained byte değeri 8-chart CPU hot değerini aşmamalıdır. Heap API yoksa veya fixture/path sahipliği doğrulanamazsa karar değerlendirilmez. Bu eşikler rapor görüldükten sonra değiştirilmeyecektir.

CI tam performans koşusunu çalıştırmaz veya sonuçtan gate üretmez. `check:browser` browser helper'ı derler; `gpuHeatmapBenchmark.test.mjs` yalnızca `--list` matrisi ile `--dry-run` karar kuralını doğrular. Gerçek renderer koşusu geliştirici tarafından yukarıdaki tek komutla, tercihen donanım GPU'su bulunan yerel sistemde başlatılır.
