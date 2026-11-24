import { expect, test } from "@playwright/test";
import { openHarness } from "./support/history.js";

const FUNCTIONAL_WEBGL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader-webgl",
  "--enable-unsafe-swiftshader",
];

test.use({ launchOptions: { args: FUNCTIONAL_WEBGL_ARGS } });

for (const backendPreference of ["webgl2", "canvas2d", "auto"] as const) {
  test(`DedicatedWorker OffscreenCanvas renders, handles input/queries, captures non-empty pixels, and recovers via recreateAndTransfer (${backendPreference})`, async ({ page }) => {
    await openHarness(page);

    const result = await page.evaluate(async (pref) => {
      const { OffscreenCanvasOwnershipManager } = await import("/src/features/chart/worker/offscreenSurfaceAdapter.ts");
      const { WorkerChartHostBridge } = await import("/src/features/chart/worker/workerRuntimeAdapter.ts");

      const container = document.createElement("div");
      container.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px;";
      const gpuCanvas = document.createElement("canvas");
      const annotationCanvas = document.createElement("canvas");
      const interactionCanvas = document.createElement("canvas");
      for (const c of [gpuCanvas, annotationCanvas, interactionCanvas]) {
        c.width = 640;
        c.height = 360;
        c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
        container.appendChild(c);
      }
      document.body.appendChild(container);

      const worker = new Worker("/harness/chartWorker.ts", { type: "module" });

      const ownership = new OffscreenCanvasOwnershipManager();
      const offscreenCanvases = {
        "gpu-scene": ownership.transferSurface("gpu-scene", gpuCanvas, { width: 640, height: 360, dpr: 1 }),
        annotation: ownership.transferSurface("annotation", annotationCanvas, { width: 640, height: 360, dpr: 1 }),
        interaction: ownership.transferSurface("interaction", interactionCanvas, { width: 640, height: 360, dpr: 1 }),
      };

      const mainChannel = new MessageChannel();
      const historyChannel = new MessageChannel();
      const ingressChannel = new MessageChannel();

      worker.postMessage(
        {
          type: "attach-panel",
          panelId: "worker-panel-1",
          marketId: "BINANCE_FUTURES:btcusdt",
          backendPreference: pref,
          ports: {
            mainPort: mainChannel.port2,
            historyPort: historyChannel.port2,
            ingressPort: ingressChannel.port2,
          },
        },
        [mainChannel.port2, historyChannel.port2, ingressChannel.port2],
      );

      const bridge = new WorkerChartHostBridge({
        panelId: "worker-panel-1",
        marketId: "BINANCE_FUTURES:btcusdt",
      });
      bridge.attachPorts({ mainPort: mainChannel.port1 });

      bridge.sendInit(
        ownership.getSurfaceSnapshot(),
        { width: 640, height: 360, dpr: 1 },
        { backendPreference: pref, offscreenCanvases },
      );

      const now = 1_700_000_040_000;
      const bars = Array.from({ length: 12 }, (_, i) => ({
        time: now + i * 60_000,
        open: 100 + i,
        high: 103 + i,
        low: 98 + i,
        close: 102 + i,
        volume: 50 + i * 5,
      }));
      historyChannel.port1.postMessage({
        channel: "history",
        kind: "history:chunk",
        panelId: "worker-panel-1",
        marketId: "BINANCE_FUTURES:btcusdt",
        generation: 0,
        seq: 1,
        revision: 1,
        payload: { timeframe: "1m", bars, hasMore: false, chunkIndex: 0 },
      });

      ingressChannel.port1.postMessage({
        channel: "ingress",
        kind: "ingress:tick",
        panelId: "worker-panel-1",
        marketId: "BINANCE_FUTURES:btcusdt",
        generation: 0,
        seq: 1,
        revision: 1,
        payload: { price: 114, size: 2.5, timestamp: now + 11 * 60_000 + 5_000, side: "buy", tradeId: "live-1" },
      });

      bridge.sendInput({ type: "pointerdown", x: 320, y: 180, button: 0, timestamp: 10 });
      bridge.sendInput({ type: "pointermove", x: 280, y: 180, buttons: 1, timestamp: 20 });
      bridge.sendInput({ type: "pointerup", x: 280, y: 180, button: 0, timestamp: 30 });
      bridge.sendInput({ type: "wheel", x: 280, y: 180, deltaX: 0, deltaY: -100, timestamp: 40 });

      // Wait briefly for worker RAF/render cycle
      await new Promise((r) => setTimeout(r, 120));

      const cap = await bridge.requestCapture({ format: "bitmap" });
      let nonZeroBytes = 0;
      if (cap.buffer) {
        const bytes = new Uint8Array(cap.buffer);
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i]! > 0 || bytes[i + 1]! > 0 || bytes[i + 2]! > 0) {
            nonZeroBytes++;
          }
        }
      }

      const hit = await bridge.requestHitTest(500, 180);
      const tooltip = await bridge.requestTooltip(500, 180);

      // Single-transfer recovery: recreate DOM canvas & transfer fresh OffscreenCanvas
      const replacementGpu = document.createElement("canvas");
      replacementGpu.width = 640;
      replacementGpu.height = 360;
      const replacementAnnotation = document.createElement("canvas");
      replacementAnnotation.width = 640;
      replacementAnnotation.height = 360;
      const replacementInteraction = document.createElement("canvas");
      replacementInteraction.width = 640;
      replacementInteraction.height = 360;

      const recovered = {
        "gpu-scene": ownership.recreateAndTransfer(
          "gpu-scene",
          () => replacementGpu,
          { width: 640, height: 360, dpr: 1 },
        ).offscreen,
        annotation: ownership.recreateAndTransfer(
          "annotation",
          () => replacementAnnotation,
          { width: 640, height: 360, dpr: 1 },
        ).offscreen,
        interaction: ownership.recreateAndTransfer(
          "interaction",
          () => replacementInteraction,
          { width: 640, height: 360, dpr: 1 },
        ).offscreen,
      };

      bridge.sendLifecycle("rehome", "context-recovery", {
        surfaces: ownership.getSurfaceSnapshot(),
        offscreenCanvases: recovered,
      });

      await new Promise((r) => setTimeout(r, 120));
      const recoveredCap = await bridge.requestCapture({ format: "bitmap" });

      const diagEvent = await new Promise<{ diagnostics?: any }>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeEventListener("message", onMessage);
          reject(new Error("Timed out waiting for worker diagnostics response"));
        }, 2000);
        const onMessage = (ev: MessageEvent) => {
          if (ev.data?.type === "diagnostics" && ev.data?.panelId === "worker-panel-1") {
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            resolve(ev.data);
          }
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({ type: "diagnostics", panelId: "worker-panel-1" });
      });

      bridge.dispose();
      worker.terminate();
      mainChannel.port1.close();
      historyChannel.port1.close();
      ingressChannel.port1.close();
      container.remove();

      return {
        capOk: cap.ok,
        capWidth: cap.width,
        capHeight: cap.height,
        nonZeroBytes,
        recoveredCapOk: recoveredCap.ok,
        hitPrice: hit.price,
        tooltipHasTitle: typeof tooltip.visible === "boolean",
        activeBackend: diagEvent?.diagnostics?.activeBackend ?? null,
        barCount: diagEvent?.diagnostics?.barCount ?? 0,
        frameCount: diagEvent?.diagnostics?.frameCount ?? 0,
      };
    }, backendPreference);

    expect(result.capOk).toBe(true);
    expect(result.capWidth).toBe(640);
    expect(result.capHeight).toBe(360);
    expect(result.nonZeroBytes).toBeGreaterThan(0);
    expect(result.recoveredCapOk).toBe(true);
    expect(typeof result.hitPrice).toBe("number");
    expect(result.tooltipHasTitle).toBe(true);
    expect(result.barCount).toBe(12);
    expect(result.frameCount).toBeGreaterThanOrEqual(1);
    if (backendPreference === "canvas2d") {
      expect(result.activeBackend).toBe("canvas2d");
    } else if (backendPreference === "webgl2") {
      expect(result.activeBackend).toBe("webgl2");
    } else {
      expect(["webgpu", "webgl2", "canvas2d"]).toContain(result.activeBackend);
    }
  });
}
