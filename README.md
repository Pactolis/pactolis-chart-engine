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
| `configureChartHost` | `features/chart/chartHost` | Runtime registration, remembered chart types, degraded-data notices, and optionally how charts adapt to the screen (`displayOptions`: compact layout, default fit, pixel-ratio cap) |
| `configureChartLocale` | `core/chartLocale` | Locale, time zone and translated text (`ChartMessageKey`) |
| `configureIndicatorDataSource` | `features/indicators/indicatorDataSource` | Data for indicators that need more than candles |
| `configureOrderbookHeatmapSettingsSource` | `features/orderbook/heatmapSettingsSource` | Order book heatmap settings |
| `configureFootprintBootstrapMarkets` | `core/syncAllowlist` | Markets assumed to have footprint data until the server says otherwise |
| `configurePerformanceTelemetry` | `core/performanceTelemetry` | Optional opt-in telemetry (`{ enabled }`); in-process metrics snapshot via `snapshotPerformanceTelemetry` — no callback/sink API |

```ts
import { configureChartLocale } from "@pactolis/chart-engine/core/chartLocale";

configureChartLocale({
  locale: () => "en-US",
  timeZone: () => "UTC",
  translate: (key) => messages[key] ?? key,
  onLocaleChange: () => () => {},
});
```

## Rendering Backends

The engine unifies `HTMLCanvasElement` and `OffscreenCanvas` under `CanvasTarget` (`@pactolis/chart-engine/core/gpu/canvasTarget`) and supports four backend preferences: `auto | webgpu | webgl2 | canvas2d`.

- **Deterministic fallback chain:** `WebGPU → WebGL2 → Canvas2D` via `createGpuSurfaceAsync` (`@pactolis/chart-engine/core/gpu/selectBackend`).
- **First-class Canvas2D:** `Canvas2dSurface` (`@pactolis/chart-engine/core/gpu/canvas2d/canvas2dSurface`) is a first-class, fully supported backend (not a degraded stub), alongside `WebGl2Surface` (`@pactolis/chart-engine/core/gpu/webgl2/webgl2Surface`) and `WebGpuSurface` (`@pactolis/chart-engine/core/gpu/webgpu/webgpuSurface`).
- **DOM-free scratch caches:** Axis, annotation, and heatmap raster caches operate on `CanvasTarget` without requiring `document` when running inside a DedicatedWorker.

## Worker-First Integration

For zero-jank multi-panel layouts, run chart rendering and data aggregation inside a DedicatedWorker using `OffscreenCanvasOwnershipManager`, `WorkerChartHostBridge`, `ChartWorkerPanelRuntime`, and `ChartWorkerHostPool`.

- **Zero-relay rule:** The main thread only wires `MessageChannel` ports (`mainPort`, `historyPort`, `ingressPort`). Market ticks and history chunks flow directly worker ↔ worker with zero main-thread relay.
- **Single-transfer recovery:** `transferControlToOffscreen()` can only be called once per `<canvas>`. On context loss or re-homing, `OffscreenCanvasOwnershipManager.recreateAndTransfer` replaces the DOM `<canvas>` node and transfers a fresh `OffscreenCanvas` to the worker.

### Main-thread example

```ts
import { OffscreenCanvasOwnershipManager } from "@pactolis/chart-engine/features/chart/worker/offscreenSurfaceAdapter";
import { WorkerChartHostBridge } from "@pactolis/chart-engine/features/chart/worker/workerRuntimeAdapter";

const ownership = new OffscreenCanvasOwnershipManager();
const offscreenCanvases = {
  "gpu-scene": ownership.transferSurface("gpu-scene", gpuCanvas, { width: 800, height: 500, dpr: 2 }),
  annotation: ownership.transferSurface("annotation", annotationCanvas, { width: 800, height: 500, dpr: 2 }),
  interaction: ownership.transferSurface("interaction", interactionCanvas, { width: 800, height: 500, dpr: 2 }),
};

const mainChannel = new MessageChannel();
const historyChannel = new MessageChannel();
const ingressChannel = new MessageChannel();

worker.postMessage(
  { type: "attach-panel", panelId: "panel-1", marketId: "BINANCE_FUTURES:btcusdt" },
  [mainChannel.port2, historyChannel.port2, ingressChannel.port2],
);

const bridge = new WorkerChartHostBridge({ panelId: "panel-1", marketId: "BINANCE_FUTURES:btcusdt" });
bridge.attachPorts({ mainPort: mainChannel.port1 });
bridge.sendInit(ownership.getSurfaceSnapshot(), { width: 800, height: 500, dpr: 2 }, {
  backendPreference: "auto",
  offscreenCanvases,
});
bridge.sendStateUpdate({
  chartType: "footprint",
  cellData: "bidask",
  scaleMode: "linear",
  orderbookHeatmapMode: "aggregated",
  residentHeatmap: true,
});
```

### Worker entry point

```ts
import { ChartWorkerHostPool } from "@pactolis/chart-engine/features/chart/worker/chartWorkerRuntime";

const pool = new ChartWorkerHostPool();

self.addEventListener("message", (event) => {
  const { panelId, marketId } = event.data;
  const [mainPort, historyPort, ingressPort] = event.ports;
  const panel = pool.createPanel({ panelId, marketId });
  panel.attachPorts({ mainPort, historyPort, ingressPort });

  // History chunks may carry full footprint `cells: [[priceBin, buyVol, sellVol], ...]`
  // and heatmap chunks (`history:heatmap-chunk` / `ingress:heatmap-tail`).
  // Per-pass diagnostics are available via `panel.getDiagnostics()`
  // (`renderMode`, `chartType`, `scaleMode`, `cellCount`, `heatmap`, `heatmapRaster`).
});
```

### Main-Thread → Worker-First Migration

1. Replace direct `ChartRuntime` mounting with `OffscreenCanvasOwnershipManager` for the 3-layer stack (`gpu-scene`, `annotation`, `interaction`).
2. Forward pointer/wheel/keyboard/resize events and chart view state patches from the host container to `WorkerChartHostBridge` (`sendInput`, `sendResize`, `sendStateUpdate`).
3. Connect your history and live-trade workers directly to `historyPort` and `ingressPort` using the `WorkerProtocolMessage` envelopes (`history:chunk` with optional `cells`, `history:heatmap-chunk`, `ingress:heatmap-tail`) from `@pactolis/chart-engine/features/chart/worker/workerProtocol`.
4. Use `bridge.requestHitTest`, `bridge.requestTooltip`, and `bridge.requestCapture` for correlated async UI queries, and `panel.getDiagnostics()` / `runtime.getDiagnostics()` for per-pass GPU and CPU raster telemetry.

## Entry points

Each public module is its own entry point, listed under `exports` in
[package.json](package.json), for example `@pactolis/chart-engine/core/engine/view`.
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
                       # (--project=default, or --project=census for the multi-chart load census)
npm run harness        # serve the harness at http://127.0.0.1:4173/harness/?chart=BINANCE_FUTURES:btcusdt
```

Browser specs live in `tests/browser/`. They open `harness/index.html`, which wires
the engine's ports with stand-ins (a JSON `/history` endpoint the specs answer with
Playwright routes, an English locale, empty indicator data) and mounts charts from
the TypeScript sources. Run `npx playwright install chromium` once before the first run.

Repository-only documentation for contributors lives under `md/` (not part of the
published package); start from
[md/INDEX.md](https://github.com/Pactolis/pactolis-chart-engine/blob/main/md/INDEX.md).
The same gates run in the
repository's GitHub Actions workflows on GitHub-hosted runners.

Development commands above are CI/runner references: on governed Pactolis workstations
tests/checks are run by CI and runners, not executed locally; external contributors run
them in their own environments.

See [CONTRIBUTING.md](https://github.com/Pactolis/pactolis-chart-engine/blob/main/CONTRIBUTING.md).

## License

Apache License 2.0. Copyright 2026 Pactolis. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
