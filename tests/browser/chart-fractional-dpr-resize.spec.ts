import { expect, test } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

interface DeviceBoxSnapshot {
  serial: number;
  inlineSize: number;
  blockSize: number;
  rectW: number;
  rectH: number;
  dpr: number;
  dims: number[][];
  needsRender: boolean;
  ink: number;
}

interface FractionalDprProbe {
  snapshot(): DeviceBoxSnapshot;
  stop(): void;
}

declare global {
  interface Window {
    __fractionalDprProbe?: FractionalDprProbe;
  }
}

for (const dpr of [1.25, 1.5]) {
  test.describe(`fractional DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test("sizes all three chart surfaces consistently and honors devicePixelContentBoxSize at fractional DPR", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await installHistory(page, { bars: buildBars(120) });
      await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt");

      const hook = page.locator('[data-testid="chart-hook"]:not([data-ft-synthetic="1"])');
      await expect(hook).toHaveCount(1);
      await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 30_000 });
      await expect(hook).toHaveAttribute("data-series-len", "120", { timeout: 30_000 });

      const panelId = await hook.getAttribute("data-panel-id");
      if (!panelId) throw new Error("Missing real chart panel ID");

      await page.evaluate(async ({ id, expectedDpr }) => {
        const { getChartRuntime } = await import("/harness/chart.ts");
        const { ChartSession } = await import("/src/features/chart/ChartSession.ts");
        const runtime = getChartRuntime(id);
        if (!runtime || !(runtime.session instanceof ChartSession)) {
          throw new Error("Missing real ChartRuntime/ChartSession");
        }
        const hookEl = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`);
        const root = hookEl?.parentElement;
        if (!root) throw new Error("Missing chart container element");
        const canvases = ["gpu-scene", "annotation", "interaction"].map((name) => {
          const canvas = root.querySelector<HTMLCanvasElement>(`canvas[data-chart-surface="${name}"]`);
          if (!canvas) throw new Error(`Missing surface canvas: ${name}`);
          return canvas;
        });
        const annotationCtx = canvases[1].getContext("2d");
        if (!annotationCtx) throw new Error("Missing annotation 2D context");

        const session = runtime.session as unknown as { needsRender: boolean };
        let serial = 0;
        let inlineSize = 0;
        let blockSize = 0;

        const ro = new ResizeObserver((entries) => {
          const entry = entries.find((item) => item.target === root) ?? entries[0];
          const box = entry?.devicePixelContentBoxSize?.[0];
          if (!box) return;
          inlineSize = box.inlineSize;
          blockSize = box.blockSize;
          serial += 1;
        });
        ro.observe(root, { box: "device-pixel-content-box" });

        const countInk = (): number => {
          const a = canvases[1];
          if (a.width <= 0 || a.height <= 0) return 0;
          const bytes = annotationCtx.getImageData(0, 0, a.width, a.height).data;
          let ink = 0;
          for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i + 3] >= 24 && Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) > 80) ink += 1;
          }
          return ink;
        };

        window.__fractionalDprProbe = {
          snapshot(): DeviceBoxSnapshot {
            const rect = root.getBoundingClientRect();
            return {
              serial,
              inlineSize,
              blockSize,
              rectW: rect.width,
              rectH: rect.height,
              dpr: window.devicePixelRatio,
              dims: canvases.map((c) => [c.width, c.height]),
              needsRender: session.needsRender,
              ink: countInk(),
            };
          },
          stop() {
            ro.disconnect();
          },
        };
        if (Math.abs(window.devicePixelRatio - expectedDpr) > 1e-6) {
          throw new Error(`Expected DPR ${expectedDpr}, got ${window.devicePixelRatio}`);
        }
      }, { id: panelId, expectedDpr: dpr });

      const expectedDimsFor = (snap: DeviceBoxSnapshot): [number, number] => {
        const scaledBoxMatchesDpr = snap.inlineSize > 0
          && snap.blockSize > 0
          && Math.abs(snap.inlineSize - snap.rectW * snap.dpr) <= 2
          && Math.abs(snap.blockSize - snap.rectH * snap.dpr) <= 2;
        return scaledBoxMatchesDpr
          ? [Math.round(snap.inlineSize), Math.round(snap.blockSize)]
          : [Math.round(snap.rectW * snap.dpr), Math.round(snap.rectH * snap.dpr)];
      };

      try {
        await expect.poll(async () => {
          const snap = await page.evaluate(() => window.__fractionalDprProbe!.snapshot());
          return snap.serial > 0 && !snap.needsRender && snap.ink > 20;
        }, { timeout: 15_000 }).toBe(true);

        const transitions = [
          { left: "10.3px", top: "10.7px", width: "800.4px", height: "500.4px" },
          { left: "17.6px", top: "13.2px", width: "641.3px", height: "379.6px" },
        ];

        for (const next of transitions) {
          const prevSerial = await page.evaluate(() => window.__fractionalDprProbe!.snapshot().serial);
          await page.evaluate(({ id, style }) => {
            const root = document.querySelector(`[data-testid="chart-hook"][data-panel-id="${id}"]`)?.parentElement;
            if (!root) throw new Error("Missing chart container element");
            root.style.inset = "auto";
            root.style.left = style.left;
            root.style.top = style.top;
            root.style.width = style.width;
            root.style.height = style.height;
          }, { id: panelId, style: next });

          await expect.poll(async () => {
            const snap = await page.evaluate(() => window.__fractionalDprProbe!.snapshot());
            if (snap.serial <= prevSerial || snap.needsRender || snap.ink <= 20) return false;
            const [targetW, targetH] = expectedDimsFor(snap);
            return targetW > 0
              && targetH > 0
              && snap.dims.every(([w, h]) => w === targetW && h === targetH);
          }, { timeout: 15_000 }).toBe(true);

          const finalSnap = await page.evaluate(() => window.__fractionalDprProbe!.snapshot());
          const expected = expectedDimsFor(finalSnap);
          expect(finalSnap.dpr).toBe(dpr);
          expect(finalSnap.dims).toEqual([expected, expected, expected]);
        }

        // Also verify ChartSession on real Chromium HTMLCanvasElements directly adopts subpixel-snapped
        // devicePixelContentBoxSize when it differs by +1px from Math.round(w * dpr).
        const directBoxResult = await page.evaluate(async (expectedDpr) => {
          const { ChartSession } = await import("/src/features/chart/ChartSession.ts");
          const cssW = expectedDpr === 1.25 ? 800.2 : 640.3;
          const cssH = expectedDpr === 1.25 ? 500.1 : 360.3;
          const exactW = Math.round(cssW * expectedDpr) + 1;
          const exactH = Math.round(cssH * expectedDpr) + 1;

          let roCallback: ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void) | null = null;
          let roInstance: ResizeObserver | null = null;
          class TestResizeObserver {
            constructor(cb: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) {
              roCallback = cb;
              roInstance = this as unknown as ResizeObserver;
            }
            observe() {}
            unobserve() {}
            disconnect() {}
          }

          const container = document.createElement("div");
          const gpuCanvas = document.createElement("canvas");
          const annotationCanvas = document.createElement("canvas");
          const interactionCanvas = document.createElement("canvas");
          const gl = gpuCanvas.getContext("webgl2");
          const annotationCtx2d = annotationCanvas.getContext("2d");
          const interactionCtx2d = interactionCanvas.getContext("2d");
          if (!gl || !annotationCtx2d || !interactionCtx2d) {
            throw new Error("Missing real canvas contexts for fractional DPR probe");
          }

          const fakeWin = {
            devicePixelRatio: expectedDpr,
            ResizeObserver: TestResizeObserver,
            requestAnimationFrame: window.requestAnimationFrame.bind(window),
            cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
            matchMedia: window.matchMedia.bind(window),
          };
          const fakeDoc = {
            defaultView: fakeWin,
            createElement: document.createElement.bind(document),
          } as unknown as Document;

          Object.defineProperty(container, "ownerDocument", { value: fakeDoc });
          container.getBoundingClientRect = () => ({
            x: 0, y: 0, left: 0, top: 0, right: cssW, bottom: cssH, width: cssW, height: cssH,
            toJSON: () => ({}),
          });

          const session = new ChartSession({
            container,
            ownerDocument: fakeDoc,
            gl,
            gpuCanvas,
            annotationCanvas,
            interactionCanvas,
            annotationCtx2d,
            interactionCtx2d,
            renderer: { render() {}, visibleRange: () => [0, 0] },
            annotation: { render() {} },
            interaction: { render() {} },
            view: { colWidth: 11, offsetX: 0, priceTop: 0, pricePerPx: 1, area: { left: 0, top: 0, width: 0, height: 0 } } as never,
            series: { length: 1 } as never,
            crosshair: { visible: false, x: 0, y: 0 },
            onRestoreContext() {},
          });

          try {
            session.activate();
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            const fallbackDims = [
              [gpuCanvas.width, gpuCanvas.height],
              [annotationCanvas.width, annotationCanvas.height],
              [interactionCanvas.width, interactionCanvas.height],
            ];
            roCallback!(
              [{
                target: container,
                devicePixelContentBoxSize: [{ inlineSize: exactW, blockSize: exactH }],
              } as unknown as ResizeObserverEntry],
              roInstance!,
            );
            await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            const boxDims = [
              [gpuCanvas.width, gpuCanvas.height],
              [annotationCanvas.width, annotationCanvas.height],
              [interactionCanvas.width, interactionCanvas.height],
            ];
            return { fallbackDims, boxDims, expectedFallback: [Math.round(cssW * expectedDpr), Math.round(cssH * expectedDpr)], expectedBox: [exactW, exactH] };
          } finally {
            session.destroy();
          }
        }, dpr);

        expect(directBoxResult.fallbackDims).toEqual([
          directBoxResult.expectedFallback,
          directBoxResult.expectedFallback,
          directBoxResult.expectedFallback,
        ]);
        expect(directBoxResult.boxDims).toEqual([
          directBoxResult.expectedBox,
          directBoxResult.expectedBox,
          directBoxResult.expectedBox,
        ]);
      } finally {
        await page.evaluate(() => {
          window.__fractionalDprProbe?.stop();
          delete window.__fractionalDprProbe;
        });
      }
    });
  });
}
