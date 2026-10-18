# Chart Engine — md/INDEX.md

Bu klasör `@pactolis/chart-engine` deposunun yalnız repository içinde kalan Türkçe teknik
referanslarıdır; published npm tarball'ına girmez (`package.json` `files` alanına bakın). Public API
source of truth [package.json](../package.json) `exports` listesi ve `src/` kaynaklarıdır; bu belgeler kaynak
referansıdır, yeni API garantisi veya semver davranışı icat etmez.

## Görev bazlı minimum okuma

| Görev | Okunacaklar |
|---|---|
| Engine'e entegre eden bir host yazma | [INTEGRATION.md](INTEGRATION.md), [CONTRACTS.md](CONTRACTS.md) |
| Render/mount davranışını anlamak | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Pointer/keyboard davranışını doğrulamak | [INTERACTIONS.md](INTERACTIONS.md) |
| History/live/repair veri invariants | [CONTRACTS.md](CONTRACTS.md) |
| Test kapılarını yorumlamak | [TESTING.md](TESTING.md) |
| Sürümleme/paketleme/consumer etkisi | [RELEASE_DISTRIBUTION.md](RELEASE_DISTRIBUTION.md) |

## Ortak kurallar

- Bu belgeler standalone clone'da geçerlidir; üst governance dosyalarına veya `../../` sibling
  checkout'lara (ör. Frontend) link vermez. Host entegrasyonu genel anlatılır.
- Her iddia ilgili source/test dosyasına repo-içi Markdown bağlantısıyla işaret eder; source ile
  çelişirse source kazanır.
