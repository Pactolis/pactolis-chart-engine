# Pactolis Chart Engine

The drawing and interaction core behind the charts on [Pactolis](https://app.pactolis.com):
footprint and candlestick rendering, price and time scales, indicators, order book
heatmaps and drawing tools, on a plain `<canvas>`.

The engine has no runtime dependencies and makes no assumptions about a UI framework,
bundler or browser storage. It does not fetch market data either: the host application
supplies data, settings, text and a few callbacks through small ports.

## Install

```sh
npm install @pactolis/chart-engine
```

## Wiring the engine

Configure the ports once at startup, before the first chart mounts:

| Port | Module | What the host supplies |
| --- | --- | --- |
| `configureChartDataSource` | `features/chart/chartDataSource` | History, live trades and repair reads for a market |
| `configureChartHost` | `features/chart/chartHost` | Runtime registration, remembered chart types, degraded-data notices |
| `configureChartLocale` | `core/chartLocale` | Locale, time zone and translated text (`ChartMessageKey`) |
| `configureIndicatorDataSource` | `features/indicators/indicatorDataSource` | Data for indicators that need more than candles |
| `configureOrderbookHeatmapSettingsSource` | `features/orderbook/heatmapSettingsSource` | Order book heatmap settings |
| `configureFootprintBootstrapMarkets` | `core/syncAllowlist` | Markets assumed to have footprint data until the server says otherwise |
| `configurePerformanceTelemetry` | `core/performanceTelemetry` | Optional timing sink |

```ts
import { configureChartLocale } from "@pactolis/chart-engine/core/chartLocale";

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key) => messages[key] ?? key,
  onLocaleChange: () => () => {},
});
```

## Entry points

Each public module is its own entry point, listed under `exports` in
[package.json](package.json), for example `@pactolis/chart-engine/core/engine`.
Separate entry points keep bundlers able to split the engine across lazy chunks.
The package also ships its TypeScript sources with source maps for debugging.
Other files in the package are internal and may change in any release.

## Development

```sh
npm ci
npm run check          # type check
npm test               # build, then run the unit tests with node --test
npm run check:exports  # every entry point exists and loads
npm run test:browser   # Playwright specs against the harness page in Chromium
npm run harness        # serve the harness at http://127.0.0.1:4173/harness/?chart=BINANCE_FUTURES:btcusdt
```

Browser specs live in `tests/browser/`. They open `harness/index.html`, which wires
the engine's ports with stand-ins (a JSON `/history` endpoint the specs answer with
Playwright routes, an English locale, empty indicator data) and mounts charts from
the TypeScript sources. Run `npx playwright install chromium` once before the first run.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. Copyright 2026 Pactolis. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
