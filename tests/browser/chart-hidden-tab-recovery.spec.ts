import { expect, test, chromium, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Issue #315 (T04-B) - live trade queue of a chart in a real hidden tab.
 *
 * Each ChartDataPipeline queues live trades and drains them on an animation frame, at
 * most 1000 trades and 4 ms per turn. A hidden page has no frames, so the drain used to
 * run only on a 250 ms timer, which Chromium wakes about once a second in a hidden tab,
 * and a chain of timers only once a minute after 5 minutes hidden ("intensive wake-up
 * throttling"). Trades keep arriving at their own pace meanwhile. Before the fix this
 * spec measured: at 100 trades/s the queue stayed under 120 trades, but a 15 s surge at
 * 2000 trades/s filled the 10000-trade queue within 9 s and dropped 7401 trades (17 %).
 * A hidden queue now drains on arrival once it holds one turn of trades, whatever the
 * timers do.
 *
 * This is the real browser lifecycle, not an emulation: the spec starts its own
 * Chromium with the 5 minute grace period shortened to 5 s (the throttling itself is
 * Chromium's own), and hides the chart's tab by activating another tab. Playwright
 * keeps the pages it drives visible, so it drives the page only before and after the
 * hidden phase and is disconnected while the tab is hidden. The synthetic-scheduler
 * proof of the same rule is tests/chartHiddenTabQueue.test.mjs.
 *
 * Given one real ChartDataPipeline with its default flush scheduler and trades from a
 * Worker at 100 trades/s with a 15 s surge at 2000 trades/s, when its tab is hidden
 * for 150 s and then shown again, then the page really was hidden and throttled (a
 * 250 ms timer chain in the page saw gaps of tens of seconds) while the trades kept
 * arriving, the queue never held more than one drain turn, no trade was dropped, and
 * every delivered trade is applied once (independent oracle: the worker's own count
 * and volume against the series' bars).
 */

const MARKET = "BINANCE_FUTURES:btcusdt";
const INTERVAL_MS = 60_000;
const RATE_PER_SECOND = 100;
// A surge well after the grace period, e.g. a liquidation cascade: more per second than one hidden drain turn.
const SURGE_RATE_PER_SECOND = 2_000;
const SURGE_AT_MS = 25_000;
const SURGE_MS = 15_000;
const HIDDEN_MS = 150_000;
const GRACE_SECONDS = 5;
const DRAIN_TURN = 1_000;

class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const resolve = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (!resolve) return;
      this.pending.delete(message.id);
      resolve(message);
    };
  }
  static async open(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`CDP socket failed: ${url}`));
    });
    return new CdpConnection(socket);
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    const message = await new Promise<{ result?: any; error?: { message: string } }>((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }
  close(): void { this.socket.close(); }
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes("\n")) return text;
    }
    if (Date.now() > deadline) throw new Error(`Chromium did not write ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("#315 hidden tab: the live queue stays bounded under Chromium's intensive timer throttling", async ({}, testInfo) => {
  test.setTimeout(HIDDEN_MS + 120_000);
  const baseURL = String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173");
  const userDataDir = mkdtempSync(join(tmpdir(), "pactolis-hidden-tab-"));
  let chrome: ChildProcess | null = null;
  let browser: Browser | null = null;
  let cdp: CdpConnection | null = null;
  try {
    chrome = spawn(chromium.executablePath(), [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      `--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/${GRACE_SECONDS}`,
      "about:blank",
    ], { stdio: "ignore" });
    const [port, path] = (await waitForFile(join(userDataDir, "DevToolsActivePort"), 20_000)).trim().split("\n");
    const endpoint = `http://127.0.0.1:${port}`;
    cdp = await CdpConnection.open(`ws://127.0.0.1:${port}${path}`);

    browser = await chromium.connectOverCDP(endpoint);
    let page = browser.contexts()[0].pages()[0];
    await page.goto(new URL("/harness/blank.html", baseURL).toString());
    const chartTargetId = (await cdp.send("Target.getTargets")).targetInfos
      .find((target: { type: string; url: string }) => target.type === "page" && target.url.includes("/harness/blank.html")).targetId;

    await page.evaluate(async ({ market, intervalMs, rate, surgeRate, surgeAt, surgeMs }) => {
      const telemetry = await import("/src/core/performanceTelemetry.ts");
      telemetry.configurePerformanceTelemetry({ enabled: true });
      const { ChartDataPipeline } = await import("/src/features/chart/ChartDataPipeline.ts");
      let deliver: ((trade: unknown) => void) | null = null;
      const pipeline = new ChartDataPipeline({
        market, intervalMs, priceStep: 1,
        services: {
          subscribeToTrades: (_market: string, cb: (trade: unknown) => void) => { deliver = cb; return () => { deliver = null; }; },
          fetchHistory: async () => [],
          fetchPriceStep: async () => 1,
          fetchPricePrecision: async () => undefined,
        } as never,
      });
      const state = {
        telemetry, pipeline, delivered: 0, volume: 0, maxQueue: 0, generated: 0, errors: [] as string[],
        // A 250 ms timer chain, like the hidden flush timer: its gaps show the throttling actually applied.
        probe: [] as Array<[number, string]>,
        queue: [] as Array<[number, number]>,
      };
      (window as any).__hiddenTab = state;

      window.addEventListener("error", (event) => state.errors.push(String(event.message)));
      window.addEventListener("unhandledrejection", (event) => state.errors.push(String(event.reason)));
      const probe = () => { state.probe.push([performance.now(), document.visibilityState]); setTimeout(probe, 250); };
      probe();
      // The worker keeps its own clock; the page only receives its messages.
      const source = `
        const started = Date.now(); let id = 0; let last = started; let due = 0;
        setInterval(() => {
          const now = Date.now();
          const surging = now - started >= ${surgeAt} && now - started < ${surgeAt + surgeMs};
          due += (now - last) * (surging ? ${surgeRate} : ${rate}) / 1000; last = now;
          const count = Math.floor(due); due -= count;
          if (count > 0) { self.postMessage({ from: id + 1, count, time: now }); id += count; }
        }, 100);`;
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      (state as any).worker = worker;
      worker.onmessage = (event) => {
        const { from, count, time } = event.data as { from: number; count: number; time: number };
        state.generated = from + count - 1;
        for (let id = from; id < from + count; id++) {
          const qty = 1 + (id % 3);
          deliver?.({ id: String(id), market, time, price: 100, qty, isBuy: id % 5 < 3 });
          state.delivered += 1;
          state.volume += qty;
          state.maxQueue = Math.max(state.maxQueue, (pipeline as any).pendingTrades.length);
        }
        state.queue.push([performance.now(), (pipeline as any).pendingTrades.length]);
      };
    }, { market: MARKET, intervalMs: INTERVAL_MS, rate: RATE_PER_SECOND, surgeRate: SURGE_RATE_PER_SECOND, surgeAt: SURGE_AT_MS, surgeMs: SURGE_MS });

    await sleep(2_000);
    const hiddenFrom = await page.evaluate(() => performance.now());
    // Playwright keeps the pages it drives visible: let go of the page, then put another tab in front.
    await browser.close();
    browser = null;
    const { targetId: coverTargetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    await cdp.send("Target.activateTarget", { targetId: coverTargetId });
    await sleep(HIDDEN_MS);
    await cdp.send("Target.activateTarget", { targetId: chartTargetId });
    await cdp.send("Target.closeTarget", { targetId: coverTargetId });

    browser = await chromium.connectOverCDP(endpoint);
    page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes("/harness/blank.html"))!;
    const hiddenTo = await page.evaluate(() => performance.now());
    const run = await page.evaluate(async ({ hiddenFrom, hiddenTo }) => {
      const state = (window as any).__hiddenTab;
      state.worker.terminate();
      const pipeline = state.pipeline;
      const deadline = performance.now() + 15_000;
      while (pipeline.pendingTrades.length > 0 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      let applied = 0;
      let volume = 0;
      for (let index = 0; index < pipeline.series.length; index++) {
        const bar = pipeline.series.at(index);
        applied += bar.count;
        volume += bar.volume;
      }
      const inHidden = state.probe.filter(([at]: [number, string]) => at > hiddenFrom + 1_000 && at < hiddenTo - 1_000);
      let maxGap = 0;
      for (let index = 1; index < inHidden.length; index++) maxGap = Math.max(maxGap, inHidden[index][0] - inHidden[index - 1][0]);
      const counters = state.telemetry.snapshotPerformanceTelemetry().counters;
      const result = {
        hiddenMs: Math.round(hiddenTo - hiddenFrom),
        hiddenSamples: inHidden.length,
        visibleSamplesWhileHidden: inHidden.filter(([, visibility]: [number, string]) => visibility !== "hidden").length,
        maxTimerGapMs: Math.round(maxGap),
        generated: state.generated,
        delivered: state.delivered,
        applied,
        deliveredVolume: state.volume,
        appliedVolume: volume,
        maxQueue: state.maxQueue,
        // Queue length after each worker message, one row per second of the hidden phase (s, max).
        queueBySecond: Object.entries(state.queue.reduce((acc: Record<number, number>, [at, length]: [number, number]) => {
          if (at < hiddenFrom || at > hiddenTo) return acc;
          const second = Math.floor((at - hiddenFrom) / 1000);
          acc[second] = Math.max(acc[second] ?? 0, length);
          return acc;
        }, {})).filter(([, length]) => (length as number) > 200).map(([second, length]) => [Number(second), length]),
        pendingAfterReturn: pipeline.pendingTrades.length,
        overflow: counters["pipeline.flush.overflow"] ?? 0,
        overflowDropped: counters["pipeline.flush.overflow_dropped"] ?? 0,
        liveTradesDropped: pipeline.dataStateInputs().liveTradesDropped,
        errors: state.errors,
      };
      pipeline.dispose();
      return result;
    }, { hiddenFrom, hiddenTo });

    console.log(JSON.stringify({ issue: 315, ratePerSecond: RATE_PER_SECOND, surgeRatePerSecond: SURGE_RATE_PER_SECOND, surgeMs: SURGE_MS, graceSeconds: GRACE_SECONDS, ...run }));

    expect(run.errors).toEqual([]);
    // The phase measured what it claims: the tab was hidden and Chromium throttled its timers to about once a minute.
    expect(run.hiddenSamples).toBeGreaterThan(0);
    expect(run.visibleSamplesWhileHidden).toBe(0);
    expect(run.maxTimerGapMs).toBeGreaterThanOrEqual(20_000);
    // Trades kept arriving while hidden.
    expect(run.delivered).toBe(run.generated);
    expect(run.delivered).toBeGreaterThanOrEqual((SURGE_RATE_PER_SECOND * SURGE_MS + RATE_PER_SECOND * (run.hiddenMs - SURGE_MS)) / 1000 * 0.9);
    // Bounded: the queue never held more than one drain turn and nothing was dropped.
    expect(run.maxQueue).toBeLessThanOrEqual(DRAIN_TURN);
    expect(run.overflowDropped).toBe(0);
    expect(run.liveTradesDropped).toBe(false);
    // Every delivered trade applied exactly once.
    expect(run.pendingAfterReturn).toBe(0);
    expect(run.applied).toBe(run.delivered);
    expect(run.appliedVolume).toBe(run.deliveredVolume);
  } finally {
    await browser?.close().catch(() => undefined);
    cdp?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome!.once("exit", resolve));
      chrome.kill();
      await exited;
    }
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }
});

// #326 adds a SHORT native freeze gate; the #315 real-hidden fixture above is unchanged.
// Playwright's focus emulation keeps every page it launches visible, so the gate starts its
// own headed Chromium and attaches with noDefaults: the default context gets no focus
// emulation, and a real companion tab genuinely hides the chart while Playwright stays attached.
const NATIVE_FREEZE_ARGS = ["--enable-automation", "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"];
const nativeFreezeTest = test.extend<{}, { nativeBrowser: Browser }>({
  nativeBrowser: [async ({ browserName }, use) => {
    if (browserName !== "chromium") throw new Error("#326 native qualification requires Chromium CDP");
    const userDataDir = mkdtempSync(join(tmpdir(), "pactolis-freeze-326-"));
    let chrome: ReturnType<typeof spawn>;
    const errors: unknown[] = [];
    try {
      chrome = spawn(chromium.executablePath(), ["--no-sandbox", "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", ...NATIVE_FREEZE_ARGS, "about:blank"], { stdio: "ignore" });
    } catch (error) {
      // #345: a synchronous spawn failure removes the temp dir it created.
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "native freeze spawn failed and temp-dir cleanup failed");
      }
      throw error;
    }
    // #345: "error" fires both when spawn never started (no pid) and for live
    // process failures (kill or message). Only a never-started error settles
    // the exit promise; a live error is aggregated and never counts as an
    // observed exit, so a live child is not falsely treated as stopped.
    let spawnError: Error | null = null;
    // #345: the "error" listener stays attached through the entire teardown:
    // a second live error is aggregated when emitted, never an unhandled
    // "error" crash, and a live error never counts as an observed exit.
    const exited = new Promise<number | null>((resolve) => {
      chrome.on("error", (error) => {
        if (!chrome.pid) { if (!spawnError) { spawnError = error as Error; resolve(null); } }
        else errors.push(error);
      });
      chrome.once("exit", (code) => resolve(code));
    });
    const boundedExit = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    let browser: Browser | null = null;
    try {
      const [port] = (await waitForFile(join(userDataDir, "DevToolsActivePort"), 20_000)).trim().split("\n");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
      try { await use(browser); } catch (error) { errors.push(error); }
    } catch (error) { errors.push(error); }
    finally {
      // #326 bounded teardown: bounded close, SIGTERM -> SIGKILL, bounded
      // confirmed exit; failures aggregate, the primary survives, the temp
      // dir is removed only after the process actually stopped, and no kill
      // is ever sent after a confirmed exit (no PID-reuse window).
      if (browser) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const closeFailure = await Promise.race([browser.close().then(() => null, (error: unknown) => error),
          new Promise<unknown>((resolve) => { timer = setTimeout(() => resolve(new Error("browser.close exceeded 15 s")), 15_000); })]);
        if (timer) clearTimeout(timer);
        if (closeFailure) errors.push(closeFailure);
      }
      if (spawnError) errors.push(spawnError);
      const running = () => chrome.exitCode === null && chrome.signalCode === null;
      let stopped = spawnError !== null || !running();
      if (!stopped) {
        chrome.kill("SIGTERM");
        stopped = await boundedExit(10_000);
        if (!stopped && running()) {
          chrome.kill("SIGKILL");
          stopped = await boundedExit(5_000);
        }
      }
      if (stopped) {
        try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }); } catch (error) { errors.push(error); }
      } else errors.push(new Error("native Chromium exit not confirmed after SIGKILL; temp dir kept"));
      if (errors.length) throw new AggregateError(errors, "native freeze fixture teardown");
    }
  }, { scope: "worker", timeout: 120_000 }],
  context: async ({ nativeBrowser }, use) => { await use(nativeBrowser.contexts()[0]); },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    try { await use(page); } finally { if (!page.isClosed()) await page.close(); }
  },
});
nativeFreezeTest.describe("#326 mounted native freeze", () => {
// Headed: the default suite has no display; Chart Lifecycle Qualification runs it under Xvfb and requires its attachment.
// Skipped at collection, before the worker fixture tries to start a headed Chromium.
nativeFreezeTest.skip(!process.env.DISPLAY, "#326 native freeze needs a display (Chart Lifecycle Qualification)");
nativeFreezeTest("#326 native frozen page: Node socket producer, enqueue ACK and actual addTrade ledger", async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const { RealBigTradesWebSocketServer } = await import("./support/realBigTradesWebSocketServer.js");
  const server = new RealBigTradesWebSocketServer();
  const total = 12_000, start = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS; // Current UTC minute, independently aligned.
  const produced: number[] = [], acks: Array<{ count: number; last: number; pending: number; at: number }> = [];
  const pulses: Array<{ seq: number; challenge: number; visible: string; at: number }> = []; let pulseCount = 0;
  const failures: unknown[] = [], pageErrors: string[] = [];
  const resumes: Array<{ after: number; at: number }> = []; let replay = (_after: number) => {};
  let primary: unknown, hasPrimary = false, cdp: any, active = true, attemptedFreeze = false, result: any, terminal: any;
  let beforeWitness: any, afterWitness: any, provenance: any, qualified = false, cover: any, challenge = 0, pulseBefore = 0, pulseSeqBefore = 0;
  const history: any[] = [];
  const collect = async (operation: () => unknown) => { try { await operation(); } catch (e) { failures.push(e); } };
  const wire: any = server;
  const originalHandleText = wire.handleText;
  // Observe real client ACK frames without altering the unchanged native helper's protocol.
  wire.handleText = function (connection: any, text: string) {
    const value = JSON.parse(text);
    if (value.type === "enqueue326") { acks.push({ ...value, at: Date.now() }); return; }
    if (value.type === "resume326") { setTimeout(() => replay(value.after), 0); return; }
    if (value.type === "pulse326") { pulseCount++; pulses.push({ seq: value.seq, challenge: value.challenge, visible: value.visible, at: Date.now() });
      if (pulses.length > 512) pulses.shift(); return; }
    return originalHandleText.call(this, connection, text);
  };
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("crash", () => pageErrors.push("native page crash; not qualification"));
  const handshakes: number[] = [], socketUrls: string[] = [];
  try {
    await server.listen();
    cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (e: any) => socketUrls.push(e.url));
    cdp.on("Network.webSocketHandshakeResponseReceived", (e: any) => handshakes.push(e.response.status));
    provenance = { node: process.version, platform: process.platform, arch: process.arch,
      playwright: (await import("node:module")).createRequire(import.meta.url)("@playwright/test/package.json").version,
      chromium: await cdp.send("Browser.getVersion"),
      testSource: { file: testInfo.file, sha256: (await import("node:crypto")).createHash("sha256").update(readFileSync(testInfo.file)).digest("hex") },
      commandLine: { arguments: (await cdp.send("Browser.getBrowserCommandLine")).arguments.map((arg: string) =>
        /^(--user-data-dir|--proxy-server|--proxy-bypass-list|--host-resolver-rules)=/.test(arg) ? arg.replace(/=.*/, "=<redacted>") : arg) }, target: await cdp.send("Target.getTargetInfo"),
      display: process.env.DISPLAY ? "present" : "absent",
      configuredLaunch: testInfo.project.use.launchOptions, declaredSourceSHA: process.env.QUALIFICATION_SHA ?? "unrecorded" };
    expect(provenance.commandLine.arguments).toContain("--enable-automation");
    for (const flag of ["--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader"])
      expect(provenance.commandLine.arguments).toContain(flag);
    expect(provenance.display).toBe("present");
    expect(provenance.commandLine.arguments.some((a: string) => a.startsWith("--headless"))).toBe(false);
    for (const flag of ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"])
      expect(provenance.commandLine.arguments).not.toContain(flag);
    await page.route("**/fapi/v1/klines*", (r) => r.fulfill({ json: [] }));
    await page.route("**/api/**", (r) => r.abort());
    // Real JSON phase 1 + production Worker PTH2 phase 2, truthful empty history.
    // Live trades alone form the original single-bar literal financial oracle.
    await page.route(/\/history(?:\?|$)/, async (route) => { try {
      const u = new URL(route.request().url()), from = Number(u.searchParams.get("from")), to = Number(u.searchParams.get("to"));
      const market = u.searchParams.get("markets"), format = u.searchParams.get("format");
      if (market !== MARKET || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to
        || to - from > 33 * INTERVAL_MS || Number(u.searchParams.get("interval")) !== INTERVAL_MS)
        throw new Error("invalid bounded freeze history request: " + u);
      const meta = { schemaVersion: 1, generatedAt: start, provenance: [{ source: "freeze326-empty-history", market,
        completeness: "complete", from, to }], footprintCoverage: { schemaVersion: 1, source: "freeze326-empty-history",
        instrument: market, authority: "provisional", status: "complete", requestedFrom: from, requestedTo: to,
        coveredFrom: from, coveredThrough: to, durableThroughId: null, projectionThroughId: null, authorityToken: null, reasonCode: null } };
      const frame = (kind: number, payload: Buffer) => {
        const header = Buffer.alloc(16); header[0] = kind; header.writeUInt32LE(payload.length, 4);
        return Buffer.concat([header, payload]);
      };
      const body = format === "binary-v2" ? Buffer.concat([Buffer.from([80, 84, 72, 50, 2, 0, 0, 0]),
        frame(1, Buffer.from(JSON.stringify({ schemaVersion: 2, interval: INTERVAL_MS, meta }))), frame(3, Buffer.alloc(16))])
        : Buffer.from(JSON.stringify({ ok: true, data: { bars: [] }, meta }));
      await route.fulfill({ body, contentType: format === "binary-v2" ? "application/x-pactolis-history-v2" : "application/json" });
      history.push({ format, from, to, bytes: body.length });
    } catch (e) { failures.push(e); await route.abort().catch((error) => failures.push(error)); } });
    await page.goto(new URL("/harness/blank.html", String(testInfo.project.use.baseURL ?? "http://127.0.0.1:4173")).toString());
    await page.evaluate(async ({ url, market }) => {
      // runtimeConfig reads public page metadata at module import, before mountChart runs.
      const meta = document.createElement("meta"); meta.name = "footprint-config"; meta.content = "targetBars=32";
      document.head.append(meta);
      const { mountChart } = await import("/harness/chart.ts");
      const { createChartSurfaceModel } = await import("/harness/chart.ts");
      const registry = await import("/harness/chart.ts");
      const { DrawingManager } = await import("/src/features/drawings/drawingManager.ts");
      const { DEFAULT_VOLUME_PROFILE_SETTINGS } = await import("/src/core/analysis/volumeProfile.ts");
      const { normalizePreviousWeekStrategySettings } = await import("/src/core/analysis/previousWeekStrategy.ts");
      const { normalizeMondayRangeSettings } = await import("/src/core/analysis/mondayRange.ts");
      const telemetry = await import("/src/core/performanceTelemetry.ts");
      telemetry.configurePerformanceTelemetry({ enabled: true });
      const state: any = { pipeline: null, socket: null, deliver: null, lateDeliver: null,
        enqueued: [] as number[], applied: [] as number[], violations: [] as string[], pulse: 0, challenge: 0, heartbeat: null as any,
        maxQueue: 0, unsubscribes: 0, telemetry, originalAddTrade: null, disposed: false,
        revision: 1, inputs: 0, callbacks: new Map(), unsubs: {}, registry, baseline: new Map(registry.listChartRuntimeEntries()) };
      (window as any).__freeze326 = state; // accessible cleanup BEFORE any partial mount/socket setup
      const root = state.root = document.createElement("div");
      root.style.cssText = "position:fixed;inset:0;width:900px;height:600px"; document.body.append(root);
      state.meta = meta;
      state.surface = createChartSurfaceModel();
      const subscribe = (kind: string, fn: Function) => {
        state.callbacks.set(kind, fn); if (kind === "trades") state.deliver = state.lateDeliver = fn;
        return () => { state.unsubs[kind] = (state.unsubs[kind] ?? 0) + 1;
          if (kind === "trades") { state.unsubscribes++; state.deliver = null; } };
      };
      const publish = () => {
        state.revision++;
        state.callbacks.get("analysis")?.({ kind: "automatic-data", market, dataRevision: state.revision, visibilityRevision: 1 });
        state.callbacks.get("revision")?.();
      };
      const analysisContext = { market, drawings: new DrawingManager(() => {}),
        profileSettings: { ...DEFAULT_VOLUME_PROFILE_SETTINGS, enabled: false },
        previousWeekStrategySettings: normalizePreviousWeekStrategySettings({ enabled: false }),
        mondayRangeSettings: normalizeMondayRangeSettings({ enabled: false }),
        previousWeekStrategyLevels: [], mondayRangeLevels: [], nakedPocs: [], referenceLevels: [] };
      const services = {
        subscribeToTrades: (_m: string, fn: Function) => subscribe("trades", fn),
        subscribeToTradeSessions: (fn: Function) => subscribe("sessions", fn),
        subscribeToTradeMarketReadiness: (fn: Function) => subscribe("readiness", fn),
        fetchPriceStep: async () => 1, fetchPriceStepResult: async () => ({ step: 1, resolved: true }),
        fetchPricePrecision: async () => undefined, fetchHistory: async () => { throw new Error("array history bypass"); },
        fetchNpocSnapshot: async () => ({ schemaVersion: 3, market, levels: [], valueAreas: [] }),
        subscribeAnalysis: (fn: Function) => subscribe("analysis", fn),
        subscribeAnalysisRevision: (fn: Function) => subscribe("revision", fn),
        getAnalysisRevisionSnapshot: () => ({ market, revision: state.revision, canonical: { status: "complete",
          market, runKey: market + "|1", generation: state.revision, revision: state.revision, failedPeriods: [] } }),
        getAnalysisContext: () => analysisContext, getAutomaticLevelsAsOf: () => null,
        updateAnalysisFromSeries: (_m: string, series: any) => {
          if (series !== registry.getChartRuntime("freeze326")?.pipeline.series) throw new Error("foreign mounted series");
          state.inputs++; publish();
        },
        notifyBarClose: publish, notifyActiveMarket() {}, notifyInteractiveCandlesReady() {}, notifyInteractiveHistorySettled() {},
        triggerAutoSync() {}, isFootprintSyncBusy: () => false, notify() {},
      };
      state.handle = mountChart(root, { type: "chart", market, timeframe: "1m", scaleMode: "linear", indicators: [] } as never,
        services as never, "freeze326", state.surface);
      const deadline = performance.now() + 20000;
      while (state.surface.status !== "ready" || !registry.getChartRuntime("freeze326")) {
        if (state.surface.status === "failed" || performance.now() > deadline) throw new Error("mounted runtime not ready");
        await new Promise((r) => setTimeout(r, 20));
      }
      const runtime: any = state.runtime = registry.getChartRuntime("freeze326"), pipeline = state.pipeline = runtime.pipeline;
      if (pipeline.series !== runtime.session.series) throw new Error("runtime/session series mismatch");
      // No scheduler override: mounted production pipeline uses its actual default scheduler.
      state.snapshot = () => JSON.parse(JSON.stringify({ revision: pipeline.series.revision,
        structureRevision: pipeline.series.structureRevision, analysisRevision: state.revision, inputs: state.inputs,
        raw: Array.from({ length: pipeline.series.length }, (_, i) => {
          const bar = pipeline.series.at(i); return { ...bar, cells: [...bar.cells.entries()] };
        }), applied: state.applied, enqueued: state.enqueued, violations: state.violations,
        counters: Object.fromEntries(Object.entries(telemetry.snapshotPerformanceTelemetry().counters)
          .filter(([key]) => key.startsWith("pipeline."))) }));
      state.witness = async () => {
        if (!runtime.getCaptureReadiness().ready) throw new Error("capture not ready");
        const capture = await runtime.captureNativePng();
        return { ready: runtime.getCaptureReadiness(), bytes: capture.bytes, width: capture.width, height: capture.height,
          type: capture.blob.type, seriesRevision: pipeline.series.revision, canonicalRevision: capture.canonicalRevision, inputs: state.inputs,
          sameSeries: pipeline.series === runtime.session.series, surface: state.surface.status,
          canvases: [...root.querySelectorAll("canvas")].map((c: any) => [c.dataset.chartSurface, c.width, c.height]) };
      };
      state.originalAddTrade = pipeline.series.addTrade;
      pipeline.series.addTrade = function (trade: any) {
        const id = Number(trade.id);
        if (id !== state.applied.length + 1) state.violations.push("actual addTrade order: " + id);
        // Record COMPLETED real instance delegation separately from socket delivery/enqueue.
        const returned = state.originalAddTrade.call(this, trade);
        state.applied.push(id);
        return returned;
      };
      // Current Chromium drops a frozen page's WebSocket (close 1006 on thaw). The page's own main
      // realm reconnects after thaw and asks the Node producer to resume after its last enqueued trade.
      state.closes = [];
      const connect = (resume: boolean) => new Promise<void>((resolve, reject) => {
        const socket = state.socket = new WebSocket(url); // true native browser socket
        socket.onmessage = (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type !== "trades") return;
          for (const trade of frame.trades) {
            const id = Number(trade.id);
            if (id !== state.enqueued.length + 1) state.violations.push("enqueue order: " + id);
            state.deliver(trade);
            state.enqueued.push(id);
            state.maxQueue = Math.max(state.maxQueue, (pipeline as any).pendingTrades.length);
          }
          socket.send(JSON.stringify({ type: "enqueue326", count: state.enqueued.length,
            last: state.enqueued.at(-1), pending: (pipeline as any).pendingTrades.length }));
        };
        socket.onopen = () => { socket.send(JSON.stringify({ type: "subscribe", requestId: "freeze326",
          markets: [market], minNotionalUsd: 0 }));
          if (resume) socket.send(JSON.stringify({ type: "resume326", after: state.enqueued.length })); resolve(); };
        socket.onerror = () => reject(new Error("native WS handshake failed"));
        socket.onclose = (e) => { state.closes.push({ code: e.code, clean: e.wasClean, at: Date.now(), visibility: document.visibilityState });
          if (!state.disposed) connect(true).catch((error) => state.violations.push(String(error))); };
      });
      state.heartbeat = setInterval(() => { if (state.socket?.readyState === WebSocket.OPEN)
        state.socket.send(JSON.stringify({ type: "pulse326", seq: ++state.pulse, challenge: state.challenge,
          visible: document.visibilityState })); }, 25);
      await connect(false);
    }, { url: server.url, market: MARKET });
    await server.waitForSubscription();
    const trade = (id: number) => { const slot = (id - 1) % 3;
      return { id: String(id), market: MARKET, time: start + id, price: slot === 0 ? 10000 : 10001,
        qty: 1, isBuy: slot !== 1, tradeCount: [2, 1, 3][slot], notionalUsd: slot === 0 ? 10000 : 10001 }; };
    const send = (from: number, count: number) => {
      const ids = Array.from({ length: count }, (_, k) => from + k);
      produced.push(...ids); server.pushBigTrades(ids.map(trade));
    };
    // A reconnected page resumes after its last enqueued id: re-send already produced trades only.
    replay = (after: number) => { resumes.push({ after, at: Date.now() });
      for (let from = after + 1; from <= produced.length; from += 300)
        server.pushBigTrades(produced.slice(from - 1, from + 299).map(trade)); };
    send(1, 3);
    await expect.poll(() => acks.at(-1)?.count).toBe(3);
    await expect.poll(() => page.evaluate(() => (window as any).__freeze326.applied.length)).toBe(3);
    expect(handshakes).toContain(101);
    expect(socketUrls).toContain(server.url);
    expect(server.socketPaths).toEqual(["/api/big-trades/stream"]);
    await expect.poll(() => page.evaluate(() => (window as any).__freeze326.runtime.getCaptureReadiness().ready)).toBe(true);
    provenance.servedSources = await page.evaluate(async () => {
      const rows = [];
      for (const path of ["/src/features/chart/ChartRuntime.ts", "/src/features/chart/ChartSession.ts", "/src/features/chart/ChartDataPipeline.ts"]) {
        const response = await fetch(path); if (!response.ok) throw new Error("source provenance fetch: " + path);
        const bytes = await response.arrayBuffer(), digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        rows.push({ path, url: response.url, bytes: bytes.byteLength, sha256: [...digest].map((n) => n.toString(16).padStart(2, "0")).join("") });
      }
      return rows;
    });
    beforeWitness = await page.evaluate(() => (window as any).__freeze326.witness());
    expect(beforeWitness.sameSeries).toBe(true);
    expect(beforeWitness.surface).toBe("ready");
    expect(beforeWitness.canvases).toHaveLength(3);
    expect(beforeWitness.canvases.every((c: any[]) => c[1] > 0 && c[2] > 0)).toBe(true);
    expect(beforeWitness.bytes).toBeGreaterThan(0);
    expect(beforeWitness.type).toBe("image/png");
    const beforeFreeze = acks.length;
    await expect.poll(() => pulseCount).toBeGreaterThan(1);
    cover = await context.newPage(); await cover.bringToFront();
    const hidden = await page.evaluate(() => { const s = (window as any).__freeze326;
      return { visibility: document.visibilityState, challenge: ++s.challenge }; });
    expect(hidden.visibility).toBe("hidden"); challenge = hidden.challenge;
    await expect.poll(() => pulses.some((p) => p.challenge === challenge && p.visible === "hidden")).toBe(true);
    attemptedFreeze = true; active = false; // failure after sending must still attempt thaw
    const frozenAck = await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    pulseBefore = pulseCount; pulseSeqBefore = pulses.at(-1)!.seq;
    // Production source is Node-owned and advances WITHOUT any page evaluation/timer/Worker.
    const frozenFrom = Date.now();
    for (let from = 4; from <= total; from += 300) {
      send(from, Math.min(300, total - from + 1));
      await sleep(10); // Node timer, not page timer
    }
    await sleep(200);
    expect(produced).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(acks.length, "no page enqueue ACK while truly frozen").toBe(beforeFreeze);
    expect(pulseCount, "no main-realm heartbeat during frozen interval").toBe(pulseBefore);
    const thawRequestedAt = Date.now();
    const activeAck = await cdp.send("Page.setWebLifecycleState", { state: "active" });
    const frozenMs = Date.now() - frozenFrom;
    active = true; // ACK required BEFORE evaluating page
    await cover.close(); cover = null; await page.bringToFront();
    await expect.poll(() => pulses.some((p) => p.challenge === challenge && p.seq > pulseSeqBefore && p.at >= thawRequestedAt)).toBe(true);
    await expect.poll(() => acks.at(-1)?.count, { timeout: 20_000 }).toBe(total);
    expect(acks.at(-1)!.at).toBeGreaterThanOrEqual(thawRequestedAt);
    await expect.poll(() => page.evaluate(() => {
      const s = (window as any).__freeze326;
      return [s.applied.length, s.pipeline.pendingTrades.length];
    }), { timeout: 20_000 }).toEqual([total, 0]);
    await expect.poll(() => page.evaluate(() => (window as any).__freeze326.runtime.getCaptureReadiness().ready)).toBe(true);
    afterWitness = await page.evaluate(() => (window as any).__freeze326.witness());
    expect(afterWitness.sameSeries).toBe(true);
    expect(afterWitness.surface).toBe("ready");
    expect(afterWitness.bytes).toBeGreaterThan(0);
    expect(afterWitness.type).toBe("image/png");
    expect(afterWitness.canvases).toHaveLength(3);
    expect(afterWitness.canvases.every((c: any[]) => c[1] > 0 && c[2] > 0)).toBe(true);
    expect(afterWitness.seriesRevision).toBeGreaterThan(beforeWitness.seriesRevision);
    expect(afterWitness.canonicalRevision).toBe(beforeWitness.canonicalRevision);
    expect(afterWitness.inputs).toBe(beforeWitness.inputs);
    expect(history.some((r) => r.format === "binary-v2")).toBe(true);
    expect(history.some((r) => r.format !== "binary-v2"
      && r.from === Math.floor((r.to - 32 * INTERVAL_MS) / INTERVAL_MS) * INTERVAL_MS
      && r.from <= start && r.to >= start && r.to - r.from <= 33 * INTERVAL_MS),
      "bounded 32 closed bars plus current live bucket").toBe(true);
    result = await page.evaluate(() => {
      const s = (window as any).__freeze326, p = s.pipeline;
      return {
        invariant: s.snapshot(), enqueued: s.enqueued, applied: s.applied, violations: s.violations,
        maxQueue: s.maxQueue, pending: p.pendingTrades.length, state: p.dataStateInputs(),
        counters: s.telemetry.snapshotPerformanceTelemetry().counters,
        bars: Array.from({ length: p.series.length }, (_, i) => {
          const b = p.series.at(i);
          return { start: b.startTime, open: b.open, high: b.high, low: b.low, close: b.close,
            volume: b.volume, delta: b.delta, count: b.count, dbs: b.deltaBySize,
            cells: [...b.cells.values()].sort((a: any, b: any) => a.priceBin - b.priceBin)
              .map((c: any) => [c.priceBin, c.buyVol, c.sellVol, c.count, c.buyCount, c.sellCount]) };
        }),
      };
    });
    expect(acks.every((ack, i) => ack.count === ack.last && ack.count <= total && ack.pending <= 10000
      && (i === 0 || ack.count > acks[i - 1].count)), "real enqueue ACK ordering/bounds").toBe(true);
    expect(result.enqueued).toEqual(produced);
    expect(result.applied, "actual instance addTrade completed delegation ledger").toEqual(produced);
    expect(result.violations).toEqual([]);
    expect(result.pending).toBe(0);
    expect(result.maxQueue).toBeLessThanOrEqual(10_000);
    expect(result.state.liveTradesDropped).toBe(false);
    expect(result.counters["pipeline.flush.overflow_dropped"] ?? 0).toBe(0);
    // Hand-written literal oracle, NOT recomputed by production bucketStart/aggregation/ta.
    expect(result.bars).toEqual([{
      start, open: 10000, high: 10001, low: 10000, close: 10001,
      volume: 12000, delta: 4000, count: 24000,
      dbs: [0, 0, 4000, 0, 0, 0, 0, 0, 0, 0],
      cells: [[10000, 4000, 0, 8000, 8000, 0], [10001, 4000, 4000, 16000, 12000, 4000]],
    }]);
    result.lifecycle = { frozenAck, activeAck, frozenMs, challenge, pulseBefore, pulseAfter: pulseCount,
      hidden, target: provenance.target, resumes, socketCloses: await page.evaluate(() => (window as any).__freeze326.closes),
      producer: "Node-owned native HTTP upgrade WebSocket fixture", enqueueACKs: acks,
      handshakes, socketUrls, scheduler: "actual default", discard: "NOT_RUN: native discard capability not established; no simulation" };
    expect(pageErrors).toEqual([]);
    qualified = true;
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    // Exception-safe on setup, freeze, producer, assertion and reactivation failures.
    if (attemptedFreeze && !active && cdp) {
      try { await cdp.send("Page.setWebLifecycleState", { state: "active" }); active = true; }
      catch (error) { failures.push(error); }
    }
    if (cover) await collect(async () => { await cover.close(); cover = null; });
    if (active && !page.isClosed()) {
      await collect(async () => {
        terminal = await page.evaluate(async () => {
          const s = (window as any).__freeze326; if (!s) return null;
          clearInterval(s.heartbeat);
          const failures: string[] = [], attempt = async (label: string, fn: () => unknown) => {
            try { await fn(); } catch (e) { failures.push(label + ": " + e); }
          };
          s.runtime ||= s.registry.getChartRuntime("freeze326"); s.pipeline ||= s.runtime?.pipeline;
          let before: any, after: any;
          await attempt("before invariant", () => { before = s.snapshot?.(); });
          const applied = s.applied.length;
          // Close delivery first; keep delegation wrapper installed through ALL terminal observations.
          for (const name of ["onclose", "onmessage", "onopen", "onerror"]) await attempt("socket " + name, () => {
            if (s.socket) s.socket[name] = null;
          });
          await attempt("socket close", () => s.socket?.close());
          const priorFailures = failures.length;
          await attempt("mount dispose", () => s.handle?.dispose());
          if (failures.length > priorFailures && s.runtime) for (const [target, name] of [
            [s.runtime.analysisBridge, "dispose"], [s.runtime.historyController, "dispose"],
            [s.runtime.replayCoordinator, "dispose"], [s.runtime.syncController, "dispose"],
            [s.runtime.captureCoordinator, "dispose"], [s.runtime, "disposeInput"], [s.runtime.session, "destroy"],
            [s.runtime.renderCoordinator, "dispose"], [s.runtime.renderer, "dispose"], [s.pipeline, "dispose"],
            [s.runtime.indicatorController, "dispose"], [s.runtime.orderbookHeatmap, "dispose"],
          ]) await attempt(name, () => target?.[name]());
          s.disposed = true;
          await attempt("late real trade callback", () => s.lateDeliver?.({ id: "999999", market: "BINANCE_FUTURES:btcusdt",
            time: 1767225650000, price: 10001, qty: 1, isBuy: true }));
          let afterLate: any; await attempt("after late invariant", () => { afterLate = s.snapshot?.(); });
          await attempt("terminal observation", () => new Promise((r) => setTimeout(r, 300)));
          await attempt("after terminal invariant", () => { after = s.snapshot?.(); });
          const result = { failures, before, afterLate, after, unsubscribes: s.unsubscribes, unsubs: s.unsubs,
            applied: s.applied.length, appliedBefore: applied, pending: s.pipeline?.pendingTrades.length,
            flushHandle: s.pipeline?.flushHandle, registryRestored: false };
          // Restore safely ONLY AFTER final snapshot; no ledger-blind window.
          await attempt("addTrade restore", () => { if (s.originalAddTrade && s.pipeline) s.pipeline.series.addTrade = s.originalAddTrade; });
          await attempt("root remove", () => s.root?.remove());
          await attempt("meta remove", () => s.meta?.remove());
          await attempt("registry check", () => {
            const entries = new Map(s.registry.listChartRuntimeEntries());
            result.registryRestored = entries.size === s.baseline.size && [...s.baseline].every(([id, rt]: any) => entries.get(id) === rt);
          });
          await attempt("probe refs release", () => { s.callbacks.clear(); s.baseline.clear();
            s.lateDeliver = s.deliver = s.pipeline = s.socket = s.originalAddTrade = s.runtime = s.handle = s.root = null;
            delete (window as any).__freeze326; });
          return result;
        });
        if (terminal) for (const check of [
          () => expect(terminal.failures).toEqual([]),
          () => expect(terminal.unsubscribes).toBe(1),
          () => expect(terminal.applied).toBe(terminal.appliedBefore),
          () => expect(terminal.pending).toBe(0),
          () => expect(terminal.flushHandle).toBeNull(),
          () => expect(terminal.afterLate).toEqual(terminal.before),
          () => expect(terminal.after).toEqual(terminal.before),
          () => { if (result) expect(terminal.before).toEqual(result.invariant); },
          () => expect(terminal.registryRestored).toBe(true),
          () => expect(["trades", "sessions", "readiness", "analysis", "revision"].every((kind) => terminal.unsubs[kind] === 1)).toBe(true),
        ]) await collect(check);
      });
      // Defer forced close until after CDP detach; terminal observations are complete.
    } else if (!active) {
      failures.push(new Error("reactivation failed; page evaluation cleanup NOT_RUN while still frozen"));
      // Do not evaluate a still-frozen page; close it after detaching CDP.
    } else failures.push(new Error("page closed/crashed; not a qualifying lifecycle result"));
    await collect(() => { wire.handleText = originalHandleText; });
    await collect(() => server.dispose());
    const owningBrowser = context.browser();
    if (cdp && !page.isClosed() && (owningBrowser === null || owningBrowser.isConnected()))
      await collect(() => cdp.detach());
    if ((!active || !terminal || terminal.failures.length) && !page.isClosed())
      await collect(() => page.close());
    await collect(() => expect(pageErrors, "post-cleanup pageerrors").toEqual([]));
    try { await testInfo.attach("freeze-qualification", { contentType: "application/json",
      body: Buffer.from(JSON.stringify({ sourceSHA: process.env.QUALIFICATION_SHA ?? "unrecorded", provenance, qualification: qualified && !hasPrimary && !failures.length ? "RUNTIME_OBSERVED" : "NOT_QUALIFIED",
        capability: qualified ? "native freeze observed" : "NOT_RUN/failed/unknown; noop or unsupported does not qualify",
        discard: "NOT_RUN: supported native discard not established; reload/crash never qualify",
        total, produced, acks, resumes, pulseCount, pulses, history, beforeWitness, afterWitness, result, terminal, pageErrors,
        primaryError: hasPrimary ? String(primary) : null, cleanupErrors: failures.map(String) })) }); }
    catch (error) { failures.push(error); }
    await collect(() => expect(pageErrors, "pageerrors through attachment completion").toEqual([]));
  }
  if (hasPrimary || failures.length) throw new AggregateError([...(hasPrimary ? [primary] : []), ...failures], "#326 primary + all cleanup errors");
});
});
