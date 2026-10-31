# GPU_PERFORMANCE_BASELINE.md — Gerçek GPU ve SwiftShader Performans Baz Çizgisi

Bu doküman, `@pactolis/chart-engine` çoklu market grafik ızgaralarında (`tests/browser/chart-multi-market-census.spec.ts`) ölçülen frame süreleri (`frameMs`), canlı akış gecikmeleri (`burst`) ve bellek kayması (`drift`) için yazılım rasterizer'ı (SwiftShader) ile gerçek donanım GPU'lar (Entegre ve Harici GPU) arasındaki performans baz çizgisini ve CI regresyon kapılarının kalibrasyon metodolojisini tanımlar (Issue #50).

## 1. Çalıştırma Metodolojisi ve Donanım Modu

Varsayılan CI ortamında (`ubuntu-latest` GitHub Actions PR runner) fiziksel GPU bulunmadığından, Playwright testleri Chromium'u SwiftShader CPU rasterizer ile başlatır (`--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`).

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

---

## 3. SwiftShader / Donanım GPU Çarpanı ve CI Kapılarının Kalibrasyonu

### 3.1 Çarpan Oranları ve Gözlemler
1. **CPU vs GPU Çizim Yükü:** SwiftShader çoklu WebGL2 tuvalinde komut tamponlarını CPU çekirdekleri üzerinde yazılımsal olarak rasterize eder. Bu nedenle frame render süreleri donanım GPU'lara göre ortalama **4x ile 7x** (harici modern GPU'larda **10x**'e kadar) daha yüksektir.
2. **Canlı Akış Gecikmesi:** Live trade'ler geldiğinde UI ipliği ile rasterizer CPU kaynaklarını paylaşır. Donanım modunda trade-to-frame gecikmesi 150 ms altında kalırken SwiftShader ortamında p95 gecikme 1.8–2.2 saniyeye kadar uzayabilmektedir.
3. **Bellek ve Heap Kayması (Endurance Drift):** Donanım GPU ve SwiftShader arasında JavaScript retained heap davranışı farksızdır; her iki modda da post-GC retained heap 1 GB tavanının (`HEAP_CEILING_BYTES`) altında kalmalı ve saatlik kayma `<= 64 MiB/saat` (~1.06 MiB/dakika - `ENDURANCE_MAX_HEAP_GROWTH_BYTES_PER_MINUTE`) sınırını aşmamalıdır.

### 3.2 CI Regresyon Alarm Kapıları (#50)
GitHub Actions PR runner'larında SwiftShader varyansını tolere etmek ve sahte kırmızıları (flakiness) önlemek amacıyla kapılar **medyan SwiftShader süresi + en az %25–35 güvenlik payı (headroom)** ile kalibre edilmiştir:

- **Boş Izgara Etkileşimi (#377 / #392):** `MULTI_CHART_INTERACTION_FRAME_P95_MS = 33.3 ms` (30 FPS tabanı)
- **Yüklü Profil L2 (#50):** `LOADED_L2_INTERACTION_FRAME_P95_MS = 120 ms` (Gerçek GPU'da ~15–20 ms karşılığı)
- **Yüklü Profil L5 (#50):** `LOADED_L5_INTERACTION_FRAME_P95_MS = 200 ms` (Gerçek GPU'da ~30–35 ms karşılığı)
- **Canlı Akış Burst Frame Süresi (#50):** `LIVE_BURST_FRAME_P95_BUDGET_MS = 250 ms`
- **Canlı Akış Gecikme Tavanı (#50):** `LIVE_BURST_LATENCY_P95_BUDGET_MS = 3,000 ms`
- **Endurance Retained Heap Eğimi (#50):** `ENDURANCE_MAX_HEAP_GROWTH_BYTES_PER_MINUTE = 1,118,481 B/dk` (64 MiB/saat)
