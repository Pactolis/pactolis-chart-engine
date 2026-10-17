// @ts-check
// The chart engine asks its host application for locale and text. Unit tests
// stand in for that host with a fixed English, UTC locale whose translations
// echo the message key and its parameters, so assertions never depend on an
// application's message catalog.
import { configureChartLocale } from "../../dist/core/chartLocale.js";

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
  onLocaleChange: () => () => {},
});

// Markets the tests treat as footprint-capable before any server answer.
const { configureFootprintBootstrapMarkets } = await import("../../dist/core/syncAllowlist.js");
configureFootprintBootstrapMarkets(["BINANCE_FUTURES:btcusdt", "BINANCE_FUTURES:ethusdt", "BINANCE_FUTURES:solusdt"]);
