# RELEASE_DISTRIBUTION.md — Sürüm, paket ve consumer uyumu

Kaynaklar: [package.json](../package.json) (`version`, `exports`, `files`, `repository`, `publishConfig`),
[.github/workflows/release.yml](../.github/workflows/release.yml), [.github/workflows/ci.yml](../.github/workflows/ci.yml).

## Workflow davranışı (çalıştırma varsayımı olmadan)

- `release.yml` main'e push veya manuel tetiklemeyle çalışır: `package.json` sürümünden `v<version>`
  etiketi türetir ve GitHub release varlığını `gh release view "$tag"` ile kontrol eder (salt Git tag
  varlığı koşul değildir). Release **yoksa** `check` + `test` + `check:exports` + `npm pack`
  çalıştırılır ve tarball `--generate-notes` ile `v<version>` release'ine eklenir; release zaten
  varsa adım atlanır. Bunun dışında npm publish davranışı workflow'da tanımlı değildir; paketin npm
  registry'sine yayınlanıp yayınlanmadığı bu repodan çıkarılamaz.
- CI her PR/main push'ta `npm pack --dry-run` çalıştırır; bu, paketin paketlenebilirliğini ve
  `files` sözleşmesinden doğan içerik listesini gösterir, beklenen `files` sözleşmesine bağımsız
  bir assertion değildir.

## Tarball içeriği

`files` alanı yalnız `dist/**` (js + map + d.ts), `src/`, `LICENSE`, `NOTICE` ve `README.md` içerir.
`CONTRIBUTING.md` ve `md/` tarball içinde **değildir**; bu yüzden published README tarballda bulunmayan
local md dosyalarına link vermez (repo GitHub URL'si `repository` alanından doğrulanmıştır).

## Consumer uyumu

- Paket adı `@pactolis/chart-engine`, `engines.node >=22`, `type: module`, ESM-only.
- Public yüzey `exports` entry'leridir; entry eklemek/çıkarmak public API değişikliğidir
  (bkz. [CONTRACTS.md](CONTRACTS.md)). `files`/`exports` dışı modüller internal sayılır ve herhangi bir
  release'te değişebilir.
- Mevcut tüketici örneği: `Pactolis-Frontend/package.json` bağımlılığı GitHub release tarball URL'siyle
  (`.../releases/download/v0.1.0/pactolis-chart-engine-0.1.0.tgz`) pinlenmiştir. Bu, sibling checkout
  gerektirmez; tarball `dist/` + `src/` taşıdığı için standalone tüketim mümkündür.
- Bu belge semver politikası veya yayın garantisi bildirmez; sürüm semantiği için source/manifest dışı
  karar gerekir.
