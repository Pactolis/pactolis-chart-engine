import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { chartLocale, configureChartLocale, t } from "../dist/core/chartLocale.js";
import { tOr } from "../dist/core/chartLocaleFallbacks.js";

function withHostLocale(localeTag, translateFn, work) {
  let prev = null;
  try { prev = chartLocale(); } catch {}
  configureChartLocale({
    locale: () => localeTag,
    timeZone: () => "UTC",
    translate: translateFn,
    onLocaleChange: () => () => {},
  });
  try {
    return work();
  } finally {
    if (prev) configureChartLocale(prev);
  }
}

test("tOr returns built-in TR and EN fallbacks with params when host echoes raw key", () => {
  withHostLocale("tr-TR", (key) => key, () => {
    assert.equal(tOr("analysis.tpo.partial"), "Kısmi");
    assert.equal(tOr("orderbook.heatmap.browserLiveSource"), "uygulama açıldığından beri");
    assert.equal(
      tOr("indicator.whaleVsCrowd.warmingBadge", { venue: "Binance", days: 2, target: 7 }),
      "Binance: ısınıyor (2/7 gün)",
    );
    assert.equal(
      tOr("indicator.volumeProfile.oiCoverage", { percent: 85 }),
      "kapsama %85",
    );
  });

  withHostLocale("en-US", (key) => key, () => {
    assert.equal(tOr("analysis.tpo.partial"), "Partial");
    assert.equal(tOr("orderbook.heatmap.browserLiveSource"), "since app opened");
    assert.equal(
      tOr("indicator.whaleVsCrowd.warmingBadge", { venue: "Binance", days: 2, target: 7 }),
      "Binance: warming (2/7d)",
    );
    assert.equal(
      tOr("indicator.volumeProfile.oiCoverage", { percent: 85 }),
      "coverage 85%",
    );
  });
});

test("tOr prefers host translation over fallback when host provides a translated string", () => {
  withHostLocale(
    "tr-TR",
    (key, params) => {
      if (key === "analysis.tpo.partial") return "Host Kısmı";
      if (key === "indicator.volumeProfile.oiCoverage") return `Host ${params?.percent}%`;
      return key;
    },
    () => {
      assert.equal(tOr("analysis.tpo.partial"), "Host Kısmı");
      assert.equal(t("analysis.tpo.partial"), "Host Kısmı");
      assert.equal(tOr("indicator.volumeProfile.oiCoverage", { percent: 42 }), "Host 42%");
      assert.equal(tOr("unknown.key.without.fallback"), "unknown.key.without.fallback");
    },
  );
});

test("dist/core/chartLocale.js stays free of CHART_LOCALE_FALLBACKS and tOr", () => {
  const url = new URL("../dist/core/chartLocale.js", import.meta.url);
  const bytes = statSync(url).size;
  const source = readFileSync(url, "utf8");
  console.log("CHART_LOCALE_JS_BYTES", bytes);
  assert.equal(source.includes("chartLocaleFallbacks"), false);
  assert.equal(source.includes("CHART_LOCALE_FALLBACKS"), false);
  assert.equal(/\btOr\b/.test(source), false);
});
