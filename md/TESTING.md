# TESTING.md — Test ve doğrulama kapıları

Komut kaynakları: [package.json](../package.json) scripts, [scripts/run-tests.mjs](../scripts/run-tests.mjs),
[scripts/check-exports.mjs](../scripts/check-exports.mjs), [playwright.config.ts](../playwright.config.ts).

## Kapılar

| Komut | Ne yapar |
|---|---|
| `npm run check` | `tsc --noEmit` tip kontrolü |
| `npm test` | Önce `npm run build` (`tsc -p tsconfig.build.json`), sonra `node --test` ile `tests/**/*.test.mjs` unit suite'i; Node 22/23+ isolation flag farkını `scripts/run-tests.mjs` çözümler |
| `npm run check:exports` | `exports` listesindeki her entry'nin var olduğunu ve yüklendiğini doğrular |
| `npm run check:browser` | `tsc -p tsconfig.browser.json` |
| `npm run test:browser` | Playwright; `default` project `chart-multi-market-census.spec.ts` ve `heatmap-multichart-frame-perf.spec.ts` hariç tüm `tests/browser/*.spec.ts`, `census` project yalnız census spec'i, `perf` project yalnız heatmap ölçüm spec'i |
| `npm run harness` | Vite ile `harness/index.html`'i servis eder |

## Unit testler

`tests/*.test.mjs` Node `--test` ile çalışır; chart pipeline/history/repair invariants
(`chartHistoryContractGuards`, `chartRepairBoundaries`, `chartHistoryFlushInvariant`), interaction
policy (`chartInteractionPolicy`, `chartWheelPolicy`), render/scene (`chartScene`, `chartSessionSurfaces`)
ve analiz/indikatör hesaplarını kapsar.

## Browser testler ve census/endurance

`tests/browser/` spec'leri harness sayfası üzerinden gerçek Chromium'da chart mount, pointer/keyboard
ownership, dispose timer, hidden-tab recovery ve native capture davranışlarını sınar.
`chart-multi-market-census.spec.ts` çoklu-market census ve endurance profillerini içerir; endurance
`CHART_ENDURANCE_MINUTES`/`CHART_ENDURANCE_PROFILE` ile koşar.

Endurance kanıt ayrımı (.github/workflows/chart-endurance.yml): **trade doğruluğu gate'tir**
(`stages.financial === "passed"`, terminal `PASS`, declared source SHA eşleşmesi zorunlu); heap ve
latency değerleri yalnız **raporlanır**, bunlar correctness gate'i değildir. Doğrulanmış bir
latency/heap iyileşme iddiası için yüklenen `endurance-evidence.json` artifact'ı gerekir; artifact yoksa
o ölçüm "çalıştı/GREEN" sayılmaz.

## Heatmap ölçümü (perf project)

`heatmap-multichart-frame-perf.spec.ts` orderbook heatmap'in Canvas2D ve GPU (varsayılan kapalı
prototip) yollarını 1, 4, 8 ve 16 grafikte ABBA sırasıyla karşılaştırır ve her grafik sayısı için bir
`heatmap-multichart-perf` JSON satırı yazar. Yalnız **raporlar**; hız eşiği yoktur, CI'da koşmaz.
Yazılımsal GL'de (SwiftShader) sadece spec'in çalıştığını gösterir; anlamlı sayı için gerçek GPU'lu
bir makinede koşulmalı:

```sh
HEATMAP_PERF_GL=default npx playwright test --project=perf       # Windows/macOS
HEATMAP_PERF_GL=angle-gl npx playwright test --project=perf      # Linux (ANGLE/OpenGL)
HEATMAP_PERF_CHARTS=4,8 HEATMAP_PERF_GL=angle-vulkan npx playwright test --project=perf
```

Alanlar: `frameMs` (invalidate'ten son grafiğin render dönüşüne, RAF beklemesi dahil),
`renderSpanMs` (karedeki ilk render başlangıcından son render bitişine), `annotationMs` ve
`gpuDrawMs` (N grafiğin yüzey çizim süreleri toplamı). 16 grafik Chromium'un sayfa başına ~16 WebGL
context sınırında olduğu için o koşu context kaybını hata saymaz, `lostContexts` olarak raporlar.

## CI ve artifact kapsamı

[.github/workflows/ci.yml](../.github/workflows/ci.yml): PR + main push, Node 22/24/26 matrisinde
`check` + `test` + `check:exports` + `npm pack --dry-run`; ayrı `browser` job (default project,
Playwright chromium) ve iki `census-shards` runner ile aggregate `census` gate. Her shard Playwright full-parallel, tek worker kullanır; aggregate yalnızca iki shard da başarılıysa geçer. Başarısız shard'lar `census-results-<shard>` benzersiz artifact'ını yükler. Browser job yalnız failure durumunda `test-results/` klasörünü
`playwright-results` artifact'ı olarak yükler.

[.github/workflows/chart-endurance.yml](../.github/workflows/chart-endurance.yml): weekly 60 dk 4L2
koşusu; manuel koşu exact 40-hex `source_sha` ister, fork PR explicit SKIP sayılır (fork PR'de
workflow kaynak tarafında exit 1 ile reddeder; bu durumda GitHub job'ının başarılı/skipped görünmesi
gate kabulü değildir), yalnız
`endurance-evidence.json` (≤256 KiB) artifact olarak yüklenir.
