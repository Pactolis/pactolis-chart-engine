import { expect, test, type Page, type Route } from "@playwright/test";
import { FUNCTIONAL_WEBGL_ARGS, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

interface TextDraw {
  surface: string;
  text: string;
  x: number;
  y: number;
  width: number;
}

const MARKET = "BINANCE_FUTURES:btcusdt";

const TF_MS = {
  "1D": 86_400_000,
  "3D": 3 * 86_400_000,
  "1W": 7 * 86_400_000,
  "12M": 12 * 30 * 86_400_000,
} as const;

function utcBucketStart(time: number, intervalMs: number): number {
  if (intervalMs === TF_MS["12M"]) {
    const d = new Date(time);
    return Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  }
  if (intervalMs === TF_MS["1W"]) {
    const day = Math.floor(time / TF_MS["1D"]) * TF_MS["1D"];
    const d = new Date(day);
    return day - ((d.getUTCDay() + 6) % 7) * TF_MS["1D"];
  }
  return Math.floor(time / intervalMs) * intervalMs;
}

function makeWireBar(
  startTime: number,
  {
    open = 87_608.3,
    high = 97_932.1,
    low = 55_126.7,
    close = 57_996.9,
    volume = 100,
    delta = 20,
    count = 1_247_050_078,
    completeness = "complete" as const,
  } = {},
) {
  return {
    t: startTime,
    o: open,
    h: high,
    l: low,
    c: close,
    v: volume,
    d: delta,
    n: count,
    cells: [[Math.floor(close / 10) * 10, volume / 2 + delta / 2, volume / 2 - delta / 2, 0, 0, count]],
    completeness,
    updatedAt: startTime + 1000,
  };
}

function repairEnvelope(
  url: URL,
  bars: ReturnType<typeof makeWireBar>[],
  { watermark = "100", degraded = false }: { watermark?: string | null; degraded?: boolean } = {},
) {
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  const interval = Number(url.searchParams.get("interval"));
  const priceStep = Number(url.searchParams.get("priceStep"));
  const market = url.searchParams.get("markets") ?? MARKET;
  const meta: Record<string, unknown> = {
    schemaVersion: 2,
    generatedAt: to,
    degraded,
    footprint: { allowed: true, available: true },
    footprintCoverage: {
      schemaVersion: 1,
      source: "binance-usdm-aggTrade",
      instrument: market,
      authority: "provisional",
      status: degraded ? "degraded" : "complete",
      requestedFrom: from,
      requestedTo: to,
      coveredFrom: from,
      coveredThrough: to,
      durableThroughId: null,
      projectionThroughId: watermark,
      authorityToken: "hud-243-token",
      reasonCode: null,
    },
  };
  if (!degraded && watermark !== null) {
    meta.repairSnapshot = {
      schemaVersion: 2,
      mode: "trade-id-v1",
      source: "binance-usdm-aggTrade",
      instrument: market,
      interval,
      priceStep,
      authority: "provisional",
      authorityToken: "hud-243-token",
      watermark,
      requestedFrom: from,
      requestedTo: to,
      coveredFrom: from,
      coveredThrough: to,
      bucketFrom: utcBucketStart(from, interval),
      bucketThrough: utcBucketStart(to, interval),
      coverageProof: {
        kind: "resolver-watermark-contiguous-v2",
        authority: "provisional",
        authorityToken: "hud-243-token",
        projectionThroughId: watermark,
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: from,
        coveredThrough: to,
        watermarkComplete: true,
      },
    };
  }
  return { ok: true, data: { bars }, meta };
}

function historyEnvelope(url: URL, bars: ReturnType<typeof makeWireBar>[]) {
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  const market = url.searchParams.get("markets") ?? MARKET;
  return {
    ok: true,
    data: { bars },
    meta: {
      schemaVersion: 2,
      generatedAt: to,
      footprint: { allowed: true, available: true },
      candleCoverage: {
        schemaVersion: 1,
        source: "binance-klines",
        instrument: market,
        ownership: "snapshot",
        status: "verified",
        requestedFrom: from,
        requestedTo: to,
        snapshotAt: to,
        closedThrough: to,
        reasonCode: null,
      },
      footprintCoverage: {
        schemaVersion: 1,
        source: "binance-usdm-aggTrade",
        instrument: market,
        authority: "canonical",
        status: "complete",
        requestedFrom: from,
        requestedTo: to,
        coveredFrom: from,
        coveredThrough: to,
        durableThroughId: null,
        projectionThroughId: "100",
        authorityToken: "hud-243-history",
        reasonCode: null,
      },
    },
  };
}

async function recordCanvasText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const draws: TextDraw[] = [];
    (window as unknown as { __hudDraws243: TextDraw[] }).__hudDraws243 = draws;
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ) {
      const surface = (this.canvas as HTMLCanvasElement | null)?.dataset?.chartSurface ?? "";
      draws.push({ surface, text: String(text), x, y, width: this.measureText(String(text)).width });
      if (draws.length > 20_000) draws.splice(0, 10_000);
      return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
    };
  });
}

async function clearCanvasText(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __hudDraws243: TextDraw[] }).__hudDraws243.length = 0;
  });
}

async function hudCanvasLine(page: Page, surface: "annotation" | "interaction"): Promise<string> {
  return page.evaluate((targetSurface) => {
    const draws = (window as unknown as { __hudDraws243: TextDraw[] }).__hudDraws243
      .filter((d) => d.surface === targetSurface && d.y < 60);
    if (!draws.length) return "";
    // Take only the latest painted frame's HUD draws (from the leftmost HUD origin backwards).
    let startIdx = 0;
    for (let i = draws.length - 1; i >= 0; i--) {
      if (draws[i].x <= 12) {
        startIdx = i;
        break;
      }
    }
    return draws.slice(startIdx).map((d) => d.text).join(" ");
  }, surface);
}

async function settleFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate((n) => new Promise<void>((resolve) => {
    let seen = 0;
    const step = () => (++seen >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), count);
}

async function mountRepairChart(page: Page, timeframe: string): Promise<void> {
  await page.evaluate(async (tf) => {
    const harness = await import("/harness/chart.ts");
    const { createHarnessServices } = await import("/harness/services.ts");
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;width:1200px;height:600px;overflow:hidden;";
    document.body.appendChild(root);

    const base = createHarnessServices({ priceStep: 10, pricePrecision: 1 });
    let sessionCb: ((session: { generation: number; epoch: number; session: string; boundaryAt: number }) => void) | null = null;
    let readinessCb: ((readiness: {
      market: string;
      generation: number;
      epoch: number;
      session: string;
      acknowledgedAt: number;
      transportGeneration: number;
      boundaryAt: number;
    }) => void) | null = null;

    const services = {
      ...base,
      subscribeToTradeSessions(cb: typeof sessionCb) {
        sessionCb = cb;
        return () => { sessionCb = null; };
      },
      subscribeToTradeMarketReadiness(cb: typeof readinessCb) {
        readinessCb = cb;
        return () => { readinessCb = null; };
      },
    };
    const surface = harness.createChartSurfaceModel();
    const handle = harness.mountChart(
      root,
      {
        type: "chart",
        market: "BINANCE_FUTURES:btcusdt",
        timeframe: tf,
        scaleMode: "linear",
        chartType: "candlestick",
        candles: true,
      } as never,
      services as never,
      "hud-243",
      surface,
    );
    (window as unknown as Record<string, unknown>).__hud243 = {
      root,
      handle,
      services,
      emitSession: (generation: number, boundaryAt: number) =>
        sessionCb?.({ generation, epoch: generation, session: `s-${generation}`, boundaryAt }),
      emitReadiness: (generation: number, boundaryAt: number) =>
        readinessCb?.({
          market: "BINANCE_FUTURES:btcusdt",
          generation,
          epoch: generation,
          session: `s-${generation}`,
          acknowledgedAt: boundaryAt,
          transportGeneration: generation,
          boundaryAt,
        }),
    };
  }, timeframe);
}

test("12M WS-before-history stays live-only on canvas and data-hud, spares closed hover, and reconciles cleanly", async ({ page }) => {
  await recordCanvasText(page);
  const now = await page.evaluate(() => Date.now());
  const open12M = utcBucketStart(now, TF_MS["12M"]);
  const closed12M = Date.UTC(new Date(open12M).getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0);

  const heldHistory: Array<{ route: Route; url: URL }> = [];
  const heldRepairs: Array<{ route: Route; url: URL }> = [];

  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("purpose") === "__repair_trade_id_v1") {
      heldRepairs.push({ route, url });
      return;
    }
    heldHistory.push({ route, url });
  });

  await openHarness(page);
  await mountRepairChart(page, "12M");

  const hook = page.locator('[data-testid="chart-hook"][data-panel-id="hud-243"]');
  await expect(hook).toHaveCount(1);

  // WS arrives before /history or __repair_trade_id_v1 resolves (live repro #243).
  await page.evaluate((t) => {
    const ctx = (window as unknown as Record<string, any>).__hud243;
    ctx.emitReadiness(1, t - 1000);
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "99",
      time: t - 500,
      price: 57_996.9,
      qty: 0.008,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 490,
    });
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "100",
      time: t - 300,
      price: 57_996.9,
      qty: 0.008,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 290,
    });
  }, now);

  await expect(hook).toHaveAttribute("data-hud", /^\[Live only\] /, { timeout: 10_000 });
  await settleFrames(page);

  const liveOnlyHudAttr = (await hook.getAttribute("data-hud")) ?? "";
  expect(liveOnlyHudAttr).toContain("[Live only]");
  expect(liveOnlyHudAttr).toContain("Vol ≈$928");
  expect(liveOnlyHudAttr).toContain("Δ ≈+$928");
  expect(liveOnlyHudAttr).toContain("Trades ≈2");

  const liveOnlyCanvas = await hudCanvasLine(page, "annotation");
  expect(liveOnlyCanvas).toContain("[Live only]");
  expect(liveOnlyCanvas).toContain("Vol ≈$928");
  expect(liveOnlyCanvas).toContain("Trades ≈2");

  // Fulfill initial /history (returning closed 2025 + open 2026 candle) while repair is STILL pending.
  await expect.poll(() => heldHistory.length).toBeGreaterThanOrEqual(1);
  while (heldHistory.length) {
    const req = heldHistory.shift()!;
    const bars = [
      makeWireBar(closed12M, { open: 42_000, high: 99_000, low: 38_000, close: 93_500, volume: 300_000, delta: 5_000, count: 1_270_402_283 }),
      makeWireBar(open12M, { count: 1_247_050_078 }),
    ];
    await req.route.fulfill({ contentType: "application/json", body: JSON.stringify(historyEnvelope(req.url, bars)) });
  }
  await expect(hook).toHaveAttribute("data-series-len", "2", { timeout: 10_000 });
  await settleFrames(page);

  // Open bar must STILL show [Live only] until __repair_trade_id_v1 reconciles.
  expect(await hook.getAttribute("data-hud")).toContain("[Live only]");

  // Hovering the closed 2025 bar must show exact closed totals with NO [Live only] or ≈.
  await clearCanvasText(page);
  const closedCoords = await page.evaluate(() => {
    const runtime = (window as unknown as Record<string, any>).__hud243.handle.runtime;
    const canvas = document.querySelector('canvas[data-chart-surface="interaction"]')!;
    const rect = canvas.getBoundingClientRect();
    const x = runtime.view.xOfIndex(0) + runtime.view.colWidth / 2;
    const y = runtime.view.area.top + runtime.view.area.height / 2;
    return { x: rect.left + x, y: rect.top + y };
  });
  await page.mouse.move(closedCoords.x, closedCoords.y);
  await settleFrames(page);

  const closedHoverAttr = (await hook.getAttribute("data-hud")) ?? "";
  expect(closedHoverAttr).not.toContain("[Live only]");
  expect(closedHoverAttr).not.toContain("≈");
  expect(closedHoverAttr).toContain("Trades 1270402283");
  const closedHoverCanvas = await hudCanvasLine(page, "interaction");
  expect(closedHoverCanvas).not.toContain("[Live only]");
  expect(closedHoverCanvas).not.toContain("≈");
  expect(closedHoverCanvas).toContain("Trades 1,270,402,283");

  // Move pointer away -> annotation HUD restores [Live only] on open bar.
  await clearCanvasText(page);
  await page.mouse.move(1195, 595);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas[data-chart-surface="interaction"]')!;
    canvas.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
  });
  await settleFrames(page);
  expect(await hook.getAttribute("data-hud")).toContain("[Live only]");

  // Push one duplicate (id=100) and one tail trade (id=101) before resolving delayed repair.
  await page.evaluate((t) => {
    const ctx = (window as unknown as Record<string, any>).__hud243;
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "100",
      time: t - 300,
      price: 57_996.9,
      qty: 0.008,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 280,
    });
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "101",
      time: t - 100,
      price: 58_010.0,
      qty: 0.01,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 90,
    });
  }, now);

  await expect.poll(() => heldRepairs.length).toBeGreaterThanOrEqual(1);
  await clearCanvasText(page);
  const repairReq = heldRepairs.pop()!;
  await repairReq.route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(
      repairEnvelope(
        repairReq.url,
        [makeWireBar(open12M, { open: 87_608.3, high: 97_932.1, low: 55_126.7, close: 57_996.9, volume: 100, delta: 20, count: 1_247_050_078 })],
        { watermark: "100" },
      ),
    ),
  });
  // Drain any remaining history requests that arrived while waiting.
  while (heldHistory.length) {
    const req = heldHistory.shift()!;
    await req.route.fulfill({ contentType: "application/json", body: JSON.stringify(historyEnvelope(req.url, [makeWireBar(closed12M), makeWireBar(open12M)])) });
  }

  await expect(hook).not.toHaveAttribute("data-hud", /\[Live only\]/, { timeout: 10_000 });
  await settleFrames(page);

  const finalHudAttr = (await hook.getAttribute("data-hud")) ?? "";
  expect(finalHudAttr).not.toContain("[Live only]");
  expect(finalHudAttr).not.toContain("≈");
  expect(finalHudAttr).toContain("O 87608.3");
  expect(finalHudAttr).toContain("H 97932.1");
  expect(finalHudAttr).toContain("L 55126.7");
  expect(finalHudAttr).toContain("Trades 1247050079");

  const finalCanvas = await hudCanvasLine(page, "annotation");
  expect(finalCanvas).not.toContain("[Live only]");
  expect(finalCanvas).not.toContain("≈");
  expect(finalCanvas).toContain("O 87608.3");
  expect(finalCanvas).toContain("Trades 1,247,050,079");
});

test("history-first open bucket stays normal even during background history reload", async ({ page }) => {
  await recordCanvasText(page);
  const now = await page.evaluate(() => Date.now());
  const open1D = utcBucketStart(now, TF_MS["1D"]);
  const closed1D = open1D - TF_MS["1D"];
  let holdBackground: Route | null = null;
  let holdBg = false;

  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("purpose") === "__repair_trade_id_v1") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(repairEnvelope(url, [makeWireBar(open1D, { count: 42_000 })], { watermark: "100" })),
      });
      return;
    }
    if (holdBg) {
      holdBackground = route;
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(historyEnvelope(url, [makeWireBar(closed1D, { count: 31_000 }), makeWireBar(open1D, { count: 42_000 })])),
    });
  });

  await openHarness(page);
  await mountRepairChart(page, "1D");
  const hook = page.locator('[data-testid="chart-hook"][data-panel-id="hud-243"]');
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 10_000 });
  await expect(hook).toHaveAttribute("data-series-len", "2", { timeout: 10_000 });
  await settleFrames(page);

  const initialHud = (await hook.getAttribute("data-hud")) ?? "";
  expect(initialHud).not.toContain("[Live only]");
  expect(initialHud).not.toContain("≈");
  expect(initialHud).toContain("Trades 42000");

  // Trigger a background refreshHistory while open bucket is already verified for (market, 1D, bucket, generation).
  holdBg = true;
  await page.evaluate(() => {
    const runtime = (window as unknown as Record<string, any>).__hud243.handle.runtime;
    void runtime.refreshHistory(false, { preserveViewport: true });
  });
  await expect.poll(() => holdBackground !== null).toBe(true);
  await settleFrames(page);

  const duringBgHud = (await hook.getAttribute("data-hud")) ?? "";
  expect(duringBgHud).not.toContain("[Live only]");
  expect(duringBgHud).toContain("Trades 42000");
  expect(await hudCanvasLine(page, "annotation")).not.toContain("[Live only]");

  await holdBackground!.fulfill({
    contentType: "application/json",
    body: JSON.stringify(historyEnvelope(new URL(holdBackground!.request().url()), [makeWireBar(closed1D, { count: 31_000 }), makeWireBar(open1D, { count: 42_000 })])),
  });
});

test("repair failure, degraded fallback, and retry transition HUD state cleanly", async ({ page }) => {
  await recordCanvasText(page);
  const now = await page.evaluate(() => Date.now());
  const open1W = utcBucketStart(now, TF_MS["1W"]);
  const closed1W = open1W - TF_MS["1W"];
  let repairAttempts = 0;

  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("purpose") === "__repair_trade_id_v1") {
      repairAttempts++;
      if (repairAttempts === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { message: "repair unavailable" } }) });
        return;
      }
      if (repairAttempts === 2) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(repairEnvelope(url, [makeWireBar(open1W, { volume: 120, count: 9_000 })], { degraded: true, watermark: null })),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(repairEnvelope(url, [makeWireBar(open1W, { volume: 120, count: 9_000 })], { watermark: "100" })),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(historyEnvelope(url, [makeWireBar(closed1W, { count: 8_000 })])),
    });
  });

  await openHarness(page);
  await mountRepairChart(page, "1W");
  const hook = page.locator('[data-testid="chart-hook"][data-panel-id="hud-243"]');
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 10_000 });

  // WS opens open1W before repair succeeds.
  await page.evaluate((t) => {
    const ctx = (window as unknown as Record<string, any>).__hud243;
    ctx.emitReadiness(1, t - 1000);
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "101",
      time: t - 200,
      price: 58_000,
      qty: 1,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 190,
    });
  }, now);

  await expect.poll(() => repairAttempts).toBeGreaterThanOrEqual(1);
  await expect(hook).toHaveAttribute("data-hud", /≈/, { timeout: 10_000 });

  // Eventually the clean 3rd attempt reconciles and clears partial/live-only markers.
  await expect.poll(() => repairAttempts, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(hook).not.toHaveAttribute("data-hud", /\[Live only\]|≈/, { timeout: 15_000 });
  await settleFrames(page);
  expect(await hook.getAttribute("data-hud")).toContain("Trades 9001");
  expect(await hudCanvasLine(page, "annotation")).toContain("Trades 9,001");
});

test("timeframe switches (1W -> 3D -> 1D -> 12M) scope readiness by generation and reject stale responses", async ({ page }) => {
  await recordCanvasText(page);
  const now = await page.evaluate(() => Date.now());
  const open1W = utcBucketStart(now, TF_MS["1W"]);
  const open3D = utcBucketStart(now, TF_MS["3D"]);
  const open1D = utcBucketStart(now, TF_MS["1D"]);
  const open12M = utcBucketStart(now, TF_MS["12M"]);

  const held3dRepairs: Array<{ route: Route; url: URL }> = [];
  const held12mRepairs: Array<{ route: Route; url: URL }> = [];
  let holdByInterval = false;

  await page.route(/\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const interval = Number(url.searchParams.get("interval"));
    const isRepair = url.searchParams.get("purpose") === "__repair_trade_id_v1";
    if (holdByInterval && isRepair && interval === TF_MS["3D"]) {
      held3dRepairs.push({ route, url });
      return;
    }
    if (holdByInterval && isRepair && interval === TF_MS["12M"]) {
      held12mRepairs.push({ route, url });
      return;
    }
    const open =
      interval === TF_MS["1W"] ? open1W
        : interval === TF_MS["3D"] ? open3D
          : interval === TF_MS["1D"] ? open1D
            : open12M;
    const count =
      interval === TF_MS["1W"] ? 700_000
        : interval === TF_MS["3D"] ? 300_000
          : interval === TF_MS["1D"] ? 100_000
            : 1_247_050_078;
    const bars = isRepair ? [makeWireBar(open, { count })] : [makeWireBar(open - interval, { count: count - 10 }), makeWireBar(open, { count })];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(isRepair ? repairEnvelope(url, bars, { watermark: "100" }) : historyEnvelope(url, bars)),
    });
  });

  await openHarness(page);
  await mountRepairChart(page, "1W");
  const hook = page.locator('[data-testid="chart-hook"][data-panel-id="hud-243"]');
  await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 10_000 });
  await page.evaluate((t) => {
    (window as unknown as Record<string, any>).__hud243.emitReadiness(1, t - 1000);
  }, now);
  await expect(hook).toHaveAttribute("data-hud", /Trades 700000/, { timeout: 10_000 });

  // Switch 1W -> 3D (hold 3D repair), then rapidly to 1D -> 12M (hold 12M repair).
  holdByInterval = true;
  await page.evaluate(async (t) => {
    const ctx = (window as unknown as Record<string, any>).__hud243;
    const runtime = ctx.handle.runtime;
    runtime.updateState({ ...runtime.getState(), timeframe: "3D" });
    await new Promise((r) => setTimeout(r, 40));
    runtime.updateState({ ...runtime.getState(), timeframe: "1D" });
    await new Promise((r) => setTimeout(r, 40));
    runtime.updateState({ ...runtime.getState(), timeframe: "12M" });
    ctx.services.pushTrade("BINANCE_FUTURES:btcusdt", {
      id: "105",
      time: t - 50,
      price: 58_500,
      qty: 1,
      isBuy: true,
      market: "BINANCE_FUTURES:btcusdt",
      source: "live",
      receivedAt: t - 40,
    });
  }, now);

  await expect(hook).toHaveAttribute("data-timeframe", "12M", { timeout: 10_000 });
  await expect(hook).toHaveAttribute("data-hud", /^\[Live only\] /, { timeout: 10_000 });

  // Fulfill stale 3D repair AFTER switching to 12M: must NOT clear 12M [Live only] or overwrite 12M bar!
  while (held3dRepairs.length) {
    const stale = held3dRepairs.shift()!;
    await stale.route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(repairEnvelope(stale.url, [makeWireBar(open3D, { count: 300_000 })], { watermark: "100" })),
    });
  }
  await settleFrames(page);
  expect(await hook.getAttribute("data-hud")).toContain("[Live only]");
  expect(await hook.getAttribute("data-hud")).toContain("Trades ≈1");

  // Fulfill current 12M repair: 12M reconciles cleanly.
  await expect.poll(() => held12mRepairs.length).toBeGreaterThanOrEqual(1);
  while (held12mRepairs.length) {
    const current = held12mRepairs.shift()!;
    await current.route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(repairEnvelope(current.url, [makeWireBar(open12M, { count: 1_247_050_078 })], { watermark: "100" })),
    });
  }
  await expect(hook).not.toHaveAttribute("data-hud", /\[Live only\]/, { timeout: 10_000 });
  await settleFrames(page);
  expect(await hook.getAttribute("data-hud")).toContain("Trades 1247050079");
  expect(await hudCanvasLine(page, "annotation")).toContain("Trades 1,247,050,079");
});
