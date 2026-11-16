import { expect, test } from "@playwright/test";

import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });

interface DeviceBoxSnapshot {
  serial: number;
  inlineSize: number;
  blockSize: number;
  dpr: number;
  dims: number[][];
  css: string[][];
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

    test("matches ResizeObserver devicePixelContentBoxSize across all three chart surfaces", async ({ page }) => {
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
            return {
              serial,
              inlineSize,
              blockSize,
              dpr: window.devicePixelRatio,
              dims: canvases.map((c) => [c.width, c.height]),
              css: canvases.map((c) => [c.style.width, c.style.height]),
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
            const targetW = Math.round(snap.inlineSize);
            const targetH = Math.round(snap.blockSize);
            return targetW > 0
              && targetH > 0
              && snap.dims.every(([w, h]) => w === targetW && h === targetH);
          }, { timeout: 15_000 }).toBe(true);

          const finalSnap = await page.evaluate(() => window.__fractionalDprProbe!.snapshot());
          const expected = [Math.round(finalSnap.inlineSize), Math.round(finalSnap.blockSize)];
          expect(finalSnap.dpr).toBe(dpr);
          expect(finalSnap.dims).toEqual([expected, expected, expected]);
        }
      } finally {
        await page.evaluate(() => {
          window.__fractionalDprProbe?.stop();
          delete window.__fractionalDprProbe;
        });
      }
    });
  });
}
