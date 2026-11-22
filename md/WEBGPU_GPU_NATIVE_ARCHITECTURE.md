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

### Aşama 2 Yol Haritası
- GPU üzerinde `pixel-bucket` mum ve alt-piksel hücre birleştirme (LOD compute).
- Görünür aralık için GPU fiyat autoscale (`min/max` parallel reduction).
- Orderbook heatmap verisinin WebGPU storage buffer + yüzde/renk compute katmanına taşınması.
- Frustum/index culling ve `drawIndirect` ile büyük serilerde tam GPU-driven çizim.

### Aşama 3 Yol Haritası
- Footprint hücre sayıları için SDF/MSDF glyph atlası ile metinlerin de Canvas2D annotation katmanından GPU pass içine taşınması.

---

## 6. Fallback Ayrıştırması ve Uygunluk Sınırları

GPU-native WebGPU yolu yalnızca `gpuSettings.nativeWebGpu === true` ve `surface.supportsNativeScene?.()` sağlandığında, aşağıdaki sahne koşullarında etkinleştirilir:

- `!view.isLogScale()` (lineer fiyat ölçeği)
- `lod !== "pixel-bucket"` (`view.colWidth >= 1`)
- `chartType === "candlestick" || chartType === "footprint"`
- `footprint` modunda `rowHeight >= CELL_PIXEL_MERGE_HEIGHT` (`2 px`)

Bu koşullardan herhangi biri sağlanmadığında (`log` ölçek, `pixel-bucket`, alt-piksel birleştirme, `footprintProfile`, `tpo`, WebGL2, Canvas2D veya `renderNativeScene` başarısızlığı) motor mevcut immediate `QuadSink` yolunu kullanır ve `featurePaths.scene = "immediate-quads"` bildirir.
