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
| `npm run test:browser` | Playwright; `default` project `chart-multi-market-census.spec.ts` hariç tüm `tests/browser/*.spec.ts`, `census` project core census spec'i, `census-load` project yüklü senaryolar (`/#308 L[2-9]/`) |
| `npm run harness` | Vite ile `harness/index.html`'i servis eder |

## Unit testler

`tests/*.test.mjs` Node `--test` ile çalışır; chart pipeline/history/repair invariants
(`chartHistoryContractGuards`, `chartRepairBoundaries`, `chartHistoryFlushInvariant`), interaction
policy (`chartInteractionPolicy`, `chartWheelPolicy`), render/scene (`chartScene`, `chartSessionSurfaces`)
ve analiz/indikatör hesaplarını kapsar. Ekrana uyarlama seçenekleri `chartDisplayOptions`, `hudLayout`,
`compactChartRender` ve `chartSessionPixelRatioCap` testlerindedir.

## Browser testler ve census/endurance

`tests/browser/` spec'leri harness sayfası üzerinden gerçek Chromium'da chart mount, pointer/keyboard
ownership, dokunma (kayıt tutan hostla sentetik pointer event'leri ve Chromium dokunma emülasyonuyla
gerçek `touch-action`/pinch/uzun basma), ekrana uyarlama seçenekleri (`chart-display-options.spec.ts`: compact
yerleşim, piksel oranı sınırı, WebGL öznitelikleri, WebGL2 alınamayan mount'un sayacı, telefonda bar özetinin sarılması), dispose timer,
hidden-tab recovery ve native capture davranışlarını sınar.
`chart-multi-market-census.spec.ts` çoklu-market census ve endurance profillerini içerir; endurance
`CHART_ENDURANCE_MINUTES`/`CHART_ENDURANCE_PROFILE` ile koşar.

Endurance kanıt ayrımı (.github/workflows/chart-endurance.yml): **trade doğruluğu gate'tir**
(`stages.financial === "passed"`, terminal `PASS`, declared source SHA eşleşmesi zorunlu); heap ve
latency değerleri yalnız **raporlanır**, bunlar correctness gate'i değildir. Doğrulanmış bir
latency/heap iyileşme iddiası için yüklenen `endurance-evidence.json` artifact'ı gerekir; artifact yoksa
o ölçüm "çalıştı/GREEN" sayılmaz.

## CI ve artifact kapsamı

[.github/workflows/ci.yml](../.github/workflows/ci.yml): PR + main push, Node 22/24/26 matrisinde
`check` + `test` + `check:exports` + `npm pack --dry-run` çalıştırır. Yalnız PR'larda (`pull_request`) çalışan ayrı `browser` job (default project,
Playwright chromium) ve tek `census` job'u bulunur (main push'ta browser/census koşmaz). Census tek worker çalışır; `#308 L2-L9` ve `#308 Tam` report-only profilleri `census-load` projesine aittir (Census Load: nightly ve `integration/approved-prs` push'u). Başarısız census `census-results` artifact'ını yükler. Browser job yalnız failure durumunda `test-results/` klasörünü
`playwright-results` artifact'ı olarak yükler.

[.github/workflows/chart-endurance.yml](../.github/workflows/chart-endurance.yml): weekly 60 dk 4L2
koşusu; manuel koşu exact 40-hex `source_sha` ister, fork PR explicit SKIP sayılır (fork PR'de
workflow kaynak tarafında exit 1 ile reddeder; bu durumda GitHub job'ının başarılı/skipped görünmesi
gate kabulü değildir), yalnız
`endurance-evidence.json` (≤256 KiB) artifact olarak yüklenir.
