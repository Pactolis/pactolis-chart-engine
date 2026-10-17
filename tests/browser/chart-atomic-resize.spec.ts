import { expect, test } from "@playwright/test";
import { buildBars, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({ launchOptions: { args: [...FUNCTIONAL_WEBGL_ARGS] } });
type Bitmap = { dims: number[][]; hash: number; ink: number; spacing: number };
type Observation = { kind: string; phase: string; target: number[]; bitmap: Bitmap; oldValues?: (string | null)[] };
type NativeProbe = { arm(phase: string): void; result(): { records: Observation[]; failures: string[] }; stop(): void };
declare global { interface Window { __atomicResizeNative?: NativeProbe } }

for (const dpr of [1, 2]) test.describe("atomic resize DPR " + dpr, () => {
  test.use({ deviceScaleFactor: dpr });
  test("retains painted bitmaps at RO and repaints at the first dimension mutation", async ({ page }, testInfo) => {
    testInfo.setTimeout(90_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const bars = buildBars(500);
    await installHistory(page, { bars });
    await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt");
    const hook = page.locator('[data-testid="chart-hook"]:not([data-ft-synthetic="1"])');
    await expect(hook).toHaveCount(1);
    await expect(hook).toHaveAttribute("data-history-loading", "false", { timeout: 30_000 });
    await expect(hook).toHaveAttribute("data-series-len", "500", { timeout: 30_000 });
    const id = await hook.getAttribute("data-panel-id");
    if (!id) throw new Error("NOTRUN: missing real panel ID");
    const canvas = hook.locator("xpath=..").locator('canvas[data-chart-surface="interaction"]');
    const box = await canvas.boundingBox();
    if (!box || box.width < 300 || box.height < 300) throw new Error("NOTRUN: invalid native chart geometry");
    const spacing = () => page.evaluate(async panelId => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const runtime = getChartRuntime(panelId);
      if (!runtime) throw new Error("NOTRUN: runtime missing");
      return runtime.view.colWidth;
    }, id);
    const initialSpacing = await spacing();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
    await page.mouse.wheel(0, -320);
    await expect.poll(spacing).not.toBe(initialSpacing);
    await page.mouse.move(5, 5);

    await page.evaluate(async ({ panelId, expectedDpr }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { ChartSession } = await import("/src/features/chart/ChartSession.ts");
      const runtime = getChartRuntime(panelId);
      if (!runtime || !(runtime.session instanceof ChartSession)) throw new Error("NOTRUN: real Session missing");
      const element = document.querySelector('[data-testid="chart-hook"][data-panel-id="' + panelId + '"]');
      const root = element?.parentElement;
      if (!root) throw new Error("NOTRUN: real container missing");
      const session = runtime.session as unknown as { container: HTMLElement; gpuCanvas: HTMLCanvasElement;
        annotationCanvas: HTMLCanvasElement; interactionCanvas: HTMLCanvasElement; ownerDocument: Document; needsRender: boolean };
      const names = ["gpu-scene", "annotation", "interaction"];
      const canvases = names.map(name => {
        const matches = root.querySelectorAll<HTMLCanvasElement>('canvas[data-chart-surface="' + name + '"]');
        if (matches.length !== 1) throw new Error("NOTRUN: ambiguous native surface " + name);
        return matches[0];
      });
      const owner = root.ownerDocument.defaultView!;
      if (session.container !== root || session.ownerDocument !== root.ownerDocument ||
          canvases.some((c, i) => c !== [session.gpuCanvas, session.annotationCanvas, session.interactionCanvas][i] ||
            c.ownerDocument !== root.ownerDocument) || owner.devicePixelRatio !== expectedDpr) {
        throw new Error("NOTRUN: native owner/session identity mismatch");
      }
      const gl = canvases[0].getContext("webgl2");
      const ctx = canvases[1].getContext("2d");
      if (!gl || gl.canvas !== canvases[0] || gl.getContextAttributes()?.preserveDrawingBuffer !== false || !ctx) {
        throw new Error("NOTRUN: existing native contexts missing");
      }
      const snapshot = (): Bitmap => {
        const a = canvases[1];
        if (a.width * a.height > 16_000_000 || a.width < 200 || a.height < 200) throw new Error("NOTRUN: bitmap bounds");
        const bytes = ctx.getImageData(0, 0, a.width, a.height).data;
        let hash = 2166136261, ink = 0;
        for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i + 3] >= 24 && Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) > 80) ink++;
        }
        return { dims: canvases.map(c => [c.width, c.height]), hash, ink, spacing: runtime.view.colWidth };
      };
      const measured = () => { const r = root.getBoundingClientRect();
        return [Math.round(r.width * owner.devicePixelRatio), Math.round(r.height * owner.devicePixelRatio)]; };
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      // Natural paints only: readiness never renders, invalidates, patches clocks or calls capture.
      let prior = "", stable = 0;
      for (let n = 0; n < 120 && stable < 4; n++) {
        await new Promise<void>(resolve => owner.requestAnimationFrame(() => resolve()));
        const state = snapshot();
        const key = JSON.stringify(state);
        stable = state.ink > 20 && !session.needsRender && key === prior ? stable + 1 : 0;
        prior = key;
      }
      if (stable < 4) throw new Error("NOTRUN: painted annotation readiness failed");
      const records: Observation[] = [], failures: string[] = [];
      let phase = "startup", previous = snapshot(), lastMeasurement = measured();
      let pending: number[] | undefined, deliveries = 0, stopped = false;
      const savedSpacing = previous.spacing;
      const fail = (message: string) => { if (failures.length < 32) failures.push(phase + ": " + message); };
      const record = (kind: string, target: number[], bitmap: Bitmap, oldValues?: (string | null)[]) => {
        if (records.length >= 64) { fail("NOTRUN: observation cap exceeded"); stopped = true; ro.disconnect(); mo.disconnect(); return; }
        records.push({ kind, phase, target: [...target], bitmap, oldValues });
      };
      const positive = (s: Bitmap) => {
        if (s.ink <= 20) fail("annotation positive ink control failed");
        if (s.spacing !== savedSpacing) fail("manual zoom spacing changed");
      };
      const coherent = (s: Bitmap, target: number[]) => {
        positive(s);
        if (!s.dims.every(dim => same(dim, target))) fail("three backing dimensions not coherent with RO target");
      };
      const mo = new owner.MutationObserver(mutations => {
        try {
          deliveries++;
          const state = snapshot();
          record("mutation-" + deliveries, pending ?? [], state, mutations.map(m => m.oldValue));
          if (!pending) fail("dimension mutation without changed RO measurement");
          else coherent(state, pending);
          if (mutations.length > 24 || mutations.some(m => !canvases.includes(m.target as HTMLCanvasElement) ||
              !["width", "height"].includes(m.attributeName!) || m.oldValue === null)) fail("invalid dimension mutation control");
          previous = state;
        } catch (error) { fail("mutation read failed: " + String(error)); }
      });
      const ro = new owner.ResizeObserver(entries => {
        try {
          if (entries.length !== 1 || entries[0].target !== root) { fail("invalid native RO owner"); return; }
          const target = measured();
          if (same(target, lastMeasurement)) return;
          const state = snapshot();
          record("RO", target, state);
          positive(state);
          if (!same(state.dims, previous.dims) || state.hash !== previous.hash || state.ink !== previous.ink) {
            fail("RO did not retain all old backing dimensions and painted annotation bitmap");
          }
          if (target.some(v => v < 200) || same(target, previous.dims[0])) fail("invalid changed-size control");
          pending = target; lastMeasurement = target; deliveries = 0;
          owner.requestAnimationFrame(() => {
            if (stopped) return;
            try {
              const state = snapshot(); record("owner-RAF", target, state); coherent(state, target);
              if (deliveries < 1) fail("owner RAF had no actual dimension mutation");
            } catch (error) { fail("owner RAF read failed: " + String(error)); }
          });
        } catch (error) { fail("RO read failed: " + String(error)); }
      });
      for (const c of canvases) mo.observe(c, { attributes: true, attributeFilter: ["width", "height"], attributeOldValue: true });
      ro.observe(root);
      record("painted-baseline", lastMeasurement, previous);
      window.__atomicResizeNative = {
        arm(next) {
          if (pending && deliveries < 1) fail("previous transition never mutated");
          phase = next;
          const now = snapshot();
          if (!same(now, previous)) fail("unrecorded bitmap/spacing drift before resize");
          positive(now); record("before", measured(), now);
        },
        result: () => ({ records, failures }),
        stop() { stopped = true; ro.disconnect(); mo.disconnect(); },
      };
    }, { panelId: id, expectedDpr: dpr });

    try {
      for (const [phase, width, height] of [["grow", 1840, 1140], ["shrink", 1440, 900]] as const) {
        await page.evaluate(p => window.__atomicResizeNative!.arm(p), phase);
        await page.setViewportSize({ width, height });
        await expect.poll(() => page.evaluate(p => {
          const data = window.__atomicResizeNative!.result();
          return data.failures.length > 0 || data.records.some(r => r.phase === p && r.kind === "owner-RAF");
        }, phase), { timeout: 15_000 }).toBe(true);
        // Keep observing real owner frames: later transitions are not cropped or reset.
        await page.evaluate(async () => { for (let n = 0; n < 4; n++)
          await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())); });
      }
      const result = await page.evaluate(() => window.__atomicResizeNative!.result());
      console.log("atomic-resize-native-bounded", JSON.stringify({ dpr, ...result }));
      expect(result.failures, "all native observed transitions").toEqual([]);
      for (const phase of ["grow", "shrink"]) {
        const records = result.records.filter(r => r.phase === phase);
        expect(records.some(r => r.kind === "RO")).toBe(true);
        expect(records.some(r => r.kind === "mutation-1" && (r.oldValues?.length ?? 0) > 0 && r.bitmap.ink > 20)).toBe(true);
        expect(records.some(r => r.kind === "owner-RAF" && r.bitmap.ink > 20)).toBe(true);
      }
    } finally {
      await page.evaluate(() => window.__atomicResizeNative?.stop());
    }
  });
});
