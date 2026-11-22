# WEBGPU_GPU_NATIVE_ARCHITECTURE.md — GPU-Native WebGPU Sahne Mimarisi

Bu belge, `@pactolis/chart-engine` içinde WebGPU'nun `#88` numaralı immediate-mode `QuadSink.rect` dar boğazını aşmak için tasarlanan GPU-native sahne mimarisini, PoC (Aşama 1) bellek düzenlerini, artımlı senkronizasyon modelini, compute geçişlerini ve aşamalı yol haritasını tanımlar (`Refs #258`).

---

## 1. Motivasyon ve Mevcut Dar Boğaz (#88)

Mevcut üç backend (`canvas2d`, `webgl2`, `webgpu`) ortak `QuadSink.rect(x, y, w, h, rgba)` arayüzü üzerinden çalışır. Bu immediate-mode yolda her karede:

1. CPU (`FootprintRenderer`), görünür tüm barların tüm mum fitil/gövde ve footprint hücre dikdörtgenlerini yeniden hesaplayıp 20 baytlık quad dizisine yazar.
2. `WebGpuQuadPipeline.uploadInstances`, her karede tüm görünür quad tamponunu `queue.writeBuffer` ile GPU'ya yeniden yükler.
3. Pan ve zoom sırasında seri verisi hiç değişmese bile tüm geometri CPU'da yeniden üretilir ve yüklenir.

GPU-native WebGPU mimarisinde mum ve footprint verisi kalıcı **GPU Storage Buffer**'larda tutulur; vertex shader'lar doğrudan `BarRecord` / `CellRecord` okuyarak piksel koordinatlarını üretir.

---

## 2. Storage Buffer Bellek Düzenleri ve Bağıl Fiyat Hassasiyeti

### 2.1 `BarRecord` (32 Bayt — 16 Bayt Hizalı)

Her mum barı 8 adet 32-bit sözcük (32 bayt) kaplar:

| Ofset (Bayt) | Alan | WGSL Tipi | Açıklama |
|---:|---|---|---|
| `0` | `openRel` | `f32` | `bar.open - priceOrigin` |
| `4` | `highRel` | `f32` | `bar.high - priceOrigin` |
| `8` | `lowRel` | `f32` | `bar.low - priceOrigin` |
| `12` | `closeRel` | `f32` | `bar.close - priceOrigin` |
| `16` | `maxVol` | `f32` | GPU compute tarafından yazılan en yüksek hücre toplam hacmi (`buyVol + sellVol`) |
| `20` | `pocBinRel` | `f32` | GPU compute tarafından yazılan POC fiyat seviyesi (`priceBin - priceOrigin`) |
| `24` | `cellOffset` | `u32` | `cells` storage buffer içindeki başlangıç indeksi |
| `28` | `cellCount` | `u32` | Bu bara ait hücre sayısı |

### 2.2 `CellRecord` (16 Bayt — 16 Bayt Hizalı)

Her footprint hücresi 4 adet 32-bit sözcük (16 bayt) kaplar:

| Ofset (Bayt) | Alan | WGSL Tipi | Açıklama |
|---:|---|---|---|
| `0` | `barIndex` | `u32` | Ait olduğu barın `bars` dizisindeki indeksi |
| `4` | `priceBinRel` | `f32` | `cell.priceBin - priceOrigin` |
| `8` | `buyVol` | `f32` | Taker-buy hacmi |
| `12` | `sellVol` | `f32` | Taker-sell hacmi |

### 2.3 `f64 → f32` `priceOrigin` Bağıl Hassasiyet Stratejisi

WGSL çekirdeklerinde `f32` 24-bit significand (~7 ondalık basamak) hassasiyetine sahiptir. `60,000+` seviyesindeki BTC fiyatlarında veya `0.01` adım büyüklüğüne sahip varlıklarda mutlak fiyatların doğrudan `f32`'ye dönüştürülmesi basamak yuvarlaması ve hücre çakışması üretir.

Bunu önlemek için:

1. Seri yüklemesinde CPU'da `f64` türünde sabit bir **`priceOrigin`** referansı seçilir (örneğin ilk barın `low` değeri).
2. Tüm bar OHLC fiyatları, hücre `priceBin` değerleri ve `ViewUniform.priceTopRel = view.priceTop - priceOrigin` farkı CPU'da **64-bit (`f64`)** olarak çıkarıldıktan sonra `f32`'ye indirgenir.
3. `y = area.top + (priceTopRel - priceRel) / pricePerPx` hesabında büyük taban fiyat elenmiş olduğu için alt-tick piksel hassasiyeti tam korunur.

---

## 3. Uniform Sözleşmesi (`ViewUniform` — 64 Bayt, 16 Bayt Hizalı)

| Ofset (Bayt) | Alan | WGSL Tipi | Açıklama |
|---:|---|---|---|
| `0` | `resolution` | `vec2<f32>` | Mantıksal canvas genişlik/yükseklik (`width, height`) |
| `8` | `visibleFrom` | `u32` | Görünür ilk bar indeksi |
| `12` | `flags` | `u32` | Bit 0: `drawHeat`, Bit 1: `drawPoc` |
| `16` | `area` | `vec4<f32>` | Çizim alanı `(left, top, width, height)` |
| `32` | `offsetX` | `f32` | 0. bar sol kenar piksel kayması |
| `36` | `colWidth` | `f32` | Sütun genişliği (CSS px) |
| `40` | `priceTopRel` | `f32` | `(view.priceTop - priceOrigin)` |
| `44` | `pricePerPx` | `f32` | Piksel başına fiyat birimi |
| `48` | `candleWidth` | `f32` | Footprint mini-mum şerit genişliği |
| `52` | `priceStep` | `f32` | Footprint fiyat adımı |
| `56` | `candleStyle` | `u32` | `0 = none`, `1 = strip`, `2 = full` |
| `60` | `visibleCellOffset` | `u32` | Görünür ilk hücre başlangıç ofseti |

---

## 4. Artımlı Senkronizasyon ve Güncelleme Modeli

| Durum | Tespit Koşulu | Storage Buffer Yüklemesi | Compute Dispatch | Uniform Yüklemesi |
|---|---|---|---|---|
| **İlk yükleme** | Pipeline yeni veya seri değişti | Tüm `BarRecord` + `CellRecord` | Tüm aktif barlar (`0 .. barCount`) | `ViewUniform` (64 B) |
| **Pan / Zoom** | Aynı `series`, `resetEpoch`, `nonTailRevision`, `barCount`, `revision` | **0 bayt** | **0 dispatch** | `ViewUniform` (64 B) |
| **Canlı tail güncelleme** | Aynı `series`, `resetEpoch`, `nonTailRevision`, `barCount`; yalnız son bar (`tailBarIndex`) değişti ve tail headroom yeterli | Yalnız son bar `BarRecord` (32 B) + son bar hücreleri (`cellCount * 16 B`, yerinde `writeBuffer`) | Yalnız son bar (`dirtyStart = tailBarIndex, dirtyCount = 1`) | `ViewUniform` (64 B) |
| **Bar devri (Append)** | Aynı `series`, `resetEpoch`, `barCount > syncedBarCount <= barCapacity`, önek (`0 .. prevTailIdx - 1`) değişmemiş, başlangıç/prevTail `startTime` sabit ve tail headroom (`TAIL_BAR_HEADROOM = 64`, `TAIL_CELL_HEADROOM = 2048`) yeterli | Yalnız `prevTailIdx .. barCount - 1` dilimi (`appendBarCount * 32 B` + `appendCellCount * 16 B`) | Yalnız eklenen/kapanan dilim (`dirtyStart = prevTailIdx, dirtyCount = appendBarCount`) | `ViewUniform` (64 B) |
| **`resetEpoch` / yapı değişimi / taşma** | `resetEpoch` artışı, önek mutasyonu, küçülme veya kapasite aşımı (`maxBufferSize` sığarsa) | 2x kapasite büyümesi + tail headroom ile tam yükleme | Tüm aktif barlar (`0 .. barCount`) | `ViewUniform` (64 B) |
| **`maxBufferSize` aşımı** | Raw `barCount * 32 > maxBufferSize` veya `totalCells * 16 > maxBufferSize` | **0 bayt** (`overflowSeries` / `overflowResetEpoch` memoize edilir, yeni `resetEpoch` gelene dek O(1) fallback) | **0 dispatch** | — (`immediate-quads` fallback) |

---

## 5. Compute & Render Geçişleri ve Yol Haritası

### Aşama 1 (Bu PoC — `#258`)
- **`COMPUTE_STATS_WGSL` (`@compute @workgroup_size(64)`):** `dirtyStart .. dirtyStart + dirtyCount` aralığındaki her bar için `cells[cellOffset .. cellOffset + cellCount)` üzerinden `maxVol` ve `pocBinRel` değerlerini GPU'da indirger.
- **`CANDLE_WGSL`:** Bar başına 12 vertex (`0..5` fitil, `6..11` gövde); `drawCandle` (`strip`) ve `drawFullCandle` (`full`) ile birebir piksel ve renk paritesi.
- **`FOOTPRINT_CELL_WGSL`:** Hücre başına 18 vertex (`0..5` POC, `6..11` sell yarısı, `12..17` buy yarısı); `clippedCellRect` ve `0.12 + 0.7 * vol / maxVol` alfa formülüyle birebir parite.
- **Tek Render Pass Sırası:** Opsiyonel grid `QuadSink` → `CANDLE_WGSL` → `FOOTPRINT_CELL_WGSL` → opsiyonel `stackedImbalance` `QuadSink` (`chart.gpu.native.overlay.ms`) aynı `GPURenderPassEncoder` içinde çizilir ve tek `queue.submit` ile gönderilir.
- **Opsiyonel Compute + Render `timestamp-query`:** Destekleyen adaptörlerde non-blocking 2-slot ring (`querySet` count = 8, slot başına 4 sorgu: `0..1` render pass, `2..3` compute pass; 32 B resolve/read buffer) kullanılır. Yalnız compute dispatch çalıştığında `resolveQuerySet(..., 4)` ve `32 B` kopyalama yapılır; salt-render karelerde yalnız 2 render sorgusu (`16 B`) çözülür. Compute süresi `chart.gpu.timestamp.compute.ms`, toplam GPU süresi (`renderNs + validComputeNs`) ise `chart.gpu.timestamp.ms` olarak kaydedilir.

### Aşama 2 (GPU LOD & WebGPU Resident Heatmap — CPU Konum)

- **GPU `pixel-bucket` Mum LOD (`lodMode = "pixel-bucket"`, `colWidth < 1`):**
  - `COMPUTE_PIXEL_BUCKET_WGSL` (`@compute @workgroup_size(64)`): Her ekran CSS piksel sütunu (`px`) için tek thread, `ViewUniform` üzerinden `[cand_start, cand_end)` bar aralığını tarar ve `openRel`, `highRel`, `lowRel`, `closeRel`, `px`, `valid` alanlarını 32 baytlık `PixelBucketRecord` dizisine indirger.
  - `PIXEL_BUCKET_CANDLE_WGSL`: Yalnız geçerli piksel kovaları için 1 px fitil + 1 px gövde çizer (`drawPixelBucketCandle` ile birebir parite).
- **GPU Alt-Piksel Footprint Hücre Birleştirme (`lodMode = "merged-cells"`, `rowHeight < CELL_PIXEL_MERGE_HEIGHT`):**
  - Tembel (lazy) `mergedRowBuffer` (slot başına 16 B: `buyVol`, `sellVol`, `frameGen`, `rowH`; **hard cap = `4 MiB`**) ve görünür bar başına `mergedBarMaxBuffer` (`f32`) kullanılır. `visibleBars * plotHeight * 16 > 4 MiB` olduğunda `prepareFrame` `{ ok: false }` döner ve `FootprintRenderer` temiz biçimde `immediate-quads` yoluna düşer.
  - `COMPUTE_MERGED_CELLS_WGSL`: Artan `frameGen` damgası sayesinde ayrı clear pass olmadan her görünür barı tek thread ile tarar, ekran piksel satırı `yTop` başına `buyVol`/`sellVol` toplar ve `mergedMax` yazar.
  - `MERGED_CELL_WGSL`: Satır yüksekliğini mum fitil aralığına kırparak (`clipPixelSpanToBar` paritesi) alt-piksel hücre yoğunluğunu çizer (POC/stackedImbalance bu LOD'da atlanır).
- **WebGPU Resident Heatmap — CPU Konum (`WebGpuNativeHeatmapPipeline`):**
  - Bu yol gerçek bir "zero-upload" GPU-native heatmap değil, **WebGPU resident heatmap (CPU konum)** katmanıdır: `HeatmapCellRecord` (32 B, 16-byte hizalı) içindeki `x, yTop, width, height` koordinatları her karede CPU'da `prepareReservedGpuCells` (`view.xOfIndex` / `view.yOfPrice`) ile hesaplanır.
  - **Pan ve zoom sırasında yükleme sıfır değildir:** koordinatlar değiştiği için görünür hücrelerin tamamı `O(n)` bayt karşılaştırmasının ardından GPU storage buffer'ına yeniden yüklenir; yükleme yalnızca `dataKey` + hücre baytlarının birebir eşleştiği **statik karelerde** (`0` bayt storage upload) atlanır.
  - Log-ölçek yoğunluk, 4 duraklı palet rampası, tam RGB yuvarlama ve 3 ondalıklı alpha quantize hesabı `HEATMAP_GPU_FRAG_SRC` & `heatmapModel.ts` sözleşmesine birebir uyumlu şekilde WGSL shader'da yürütülür ve mevcut frame dokusu üzerine `loadOp: "load", storeOp: "store"` + plot scissor ile çizilir (`chart.gpu.heatmap.render.ms`, `gpu.native.heatmap.upload.bytes`).
  - **64 MiB per-chart / 256 MiB module-wide** bütçe defterine (`HEATMAP_WEBGPU_CHART_BUDGET_BYTES` / `HEATMAP_WEBGPU_MODULE_BUDGET_BYTES`) tabidir ve bütçe/hata durumunda `"cpu"` fallback'ine döner.

### Aşama 3 (Gerçek GPU-Native Orderbook Heatmap & Gelecek Yol Haritası)

- **Gerçek GPU-Native Orderbook Heatmap:** Zaman×fiyat orderbook ızgarasının kalıcı GPU storage buffer/dokuda tutulması; ekran konumunun her karede vertex shader içinde `ViewUniform` (`offsetX`, `colWidth`, `priceTopRel`, `pricePerPx`) üzerinden hesaplanarak **pan/zoom sırasında da 0 bayt veri yüklemesi** elde edilmesi.
- **GPU Görünür Fiyat Autoscale Reduction Notu:** Birkaç yüz görünür barda CPU min/max taraması mikrosaniye mertebesinde tamamlanırken WebGPU `mapAsync` readback'i en az 1 kare gecikme ekler; bu nedenle GPU autoscale bu PR'da yer almaz ve yalnızca ileride binlerce görünür bar için CPU maliyeti ölçülürse ayrı bir PR'da gerekçeyle eklenecektir.
- **Büyük Seri GPU-Driven Çizim & Metin:** Frustum/index culling + `drawIndirect` ve footprint hücre sayıları için SDF/MSDF glyph atlası.

---

## 6. Fallback Ayrıştırması ve Uygunluk Sınırları

GPU-native WebGPU sahne yolu yalnızca `gpuSettings.nativeWebGpu === true` ve `surface.supportsNativeScene?.()` sağlandığında, aşağıdaki sahne koşullarında etkinleştirilir:

- `!view.isLogScale()` (lineer fiyat ölçeği)
- `chartType === "candlestick" || chartType === "footprint"` (Aşama 2 ile `lod === "pixel-bucket"` ve `rowHeight < CELL_PIXEL_MERGE_HEIGHT` da GPU-native'dir)
- Alt-piksel birleştirme tamponu `visibleBars * plotHeight * 16 <= 4 MiB` ve seri tamponları `maxBufferSize` sınırı içinde kalmalıdır

WebGPU resident heatmap (CPU konum) yolu ise `nativeWebGpu` bayrağına **değil**, mevcut **`residentHeatmap`** opt-in bayrağına ve `webgpu` backend'ine bağlıdır (`?webgpuNative=0` ile WebGPU resident heatmap kapatılamaz). `backendKind === "webgpu"`, `residentHeatmap === true`, `surface.supportsNativeHeatmap?.()` ve `64 MiB / 256 MiB` bütçe limitleri sağlandığında `featurePaths["orderbook-heatmap"] = "webgpu"` etkinleşir.

Bu koşullardan herhangi biri sağlanmadığında (`log` ölçek, `footprintProfile`, `tpo`, `4 MiB` merged-cell sınırı aşımı, `maxBufferSize` taşması, heatmap bütçe/hata durumu, WebGL2 veya Canvas2D) motor mevcut fallback yoluna (`immediate-quads` veya `"cpu"`) düşer.

---

## 7. `nativeWebGpu` Varsayılan Bayrak Karar Kuralı ve Büyük Sahne Profili

`nativeWebGpu` bayrağının varsayılan olarak açılıp açılmaması (`DEFAULT_GO` / `DEFAULT_NO_GO`), donanım üzerinde çalıştırılan kıyas koşusunun `defaultGate` kapısı ile değerlendirilir:

- **Büyük sahne profili (`requiredProfile: "large"`):** `>= 2.500 bar × 120 hücre` (`fitColumns = 120`, grafik başına `300.000`, `4` grafikte toplam `1.200.000` hücre):
  - Komut: `npm run benchmark:webgpu-native:large -- --output-dir gpu-rapor`
  - `standard` profili (`600 × 40`) veya küçültülmüş `large` fixture'lar varsayılan kapı için **`NOT_EVALUATED_PROFILE`** üretir (`DEFAULT_GO` verilemez).
  - `timestamp-query` desteği yoksa veya timestamp / rAF örneği eksikse **`NOT_EVALUATED_INCOMPLETE`** üretilir.
- **`WEBGPU_NATIVE_DEFAULT_DECISION_RULE` (`DEFAULT_GO` koşulları):**
  1. `pan`, `zoom` ve `live` senaryolarında `gpu-native` `chart.frame.render.ms` `maxP95Ratio <= 0.80` (`p95Ms <= immediate p95Ms * 0.80`)
  2. `pan`, `zoom` ve `live` senaryolarında `missedFrameRatio` regresyonu olmaması (`gpuNative.raf.missedFrameRatio <= immediate.raf.missedFrameRatio`)
  3. Tüm senaryolarda ve rollover karelerinde `chart.gpu.timestamp.ms` (`render + compute` toplam GPU pass süresi) `p95Ms <= 4.0 ms/grafik`
  4. `live-rollover` rollover karelerinde `frame.render` `p99Ms <= immediate p99Ms * 1.05` ve upload tasarrufu sağlanması
  5. `pan` ve `zoom` senaryolarında `gpu.native.upload.dataBytes = 0`
  6. Görsel parite `matchRatio >= 0.99` (kanal toleransı `<= 2`) ve `fallbacks.length === 0`
  7. Varsayılanın açılması için **en az bir dGPU ve bir iGPU (`requiredDeviceClasses: ["dgpu", "igpu"]`)** üzerinde `DEFAULT_GO` doğrulanması zorunludur.
