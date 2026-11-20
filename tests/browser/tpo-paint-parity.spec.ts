import { expect, test } from "@playwright/test";
import { buildBars, FROZEN_NOW, FUNCTIONAL_WEBGL_ARGS, installHistory, openHarness } from "./support/history.js";

test.use({
  viewport: { width: 1024, height: 370 },
  deviceScaleFactor: 1.25,
  launchOptions: {
    args: [...FUNCTIONAL_WEBGL_ARGS],
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  },
});

const barMs = 30 * 60_000;
const startTime = Date.UTC(2026, 0, 13);
const template = buildBars(1)[0];
const bars = Array.from({ length: 121 }, (_, index) => {
  const price = 60_000 + 10 * (index % 8) + 40 * Math.floor(index / 48);
  return { ...template, t: startTime + index * barMs, o: price, c: price + 10, h: price + 30, l: price - 20 };
});

for (const scenario of ["blocks", "collapsed", "letters", "volume underlay"] as const) {
  test(`annotation pixels match individual TPO draws in ${scenario}`, async ({ page }) => {
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue() : route.abort());
    await installHistory(page, { bars });
    await openHarness(page, "?chart=BINANCE_FUTURES:btcusdt&timeframe=30m&type=tpo&priceStep=10");
    await expect(page.getByTestId("chart-hook")).toHaveAttribute("data-series-len", String(bars.length));

    const result = await page.evaluate(async ({ scenario, now }) => {
      const { getChartRuntime } = await import("/harness/chart.ts");
      const { buildTpoProfileGroups, tpoBracketLabel } = await import("/src/core/analysis/tpoProfile.ts");
      const { ChartChange } = await import("/src/core/render/scene/chartScene.ts");
      const { neighbourBin, quantizeToStep } = await import("/src/core/priceStep.ts");
      const { settings } = await import("/src/core/settings.ts");
      const { chartLocale, configureChartLocale, tOr } = await import("/src/core/chartLocale.ts");
      const { configurePerformanceTelemetry, snapshotPerformanceTelemetry } = await import("/src/core/performanceTelemetry.ts");
      const runtime = getChartRuntime("harness-chart")!;
      const overlay = Reflect.get(runtime, "overlay") as import("../../src/core/render/overlay.js").Overlay;
      const { view } = runtime;
      const { series } = runtime.pipeline;
      const ctx = document.querySelector<HTMLCanvasElement>('canvas[data-chart-surface="annotation"]')!.getContext("2d")!;
      const { width, height } = ctx.canvas;
      // A detached canvas can inherit different text direction from this host.
      ctx.canvas.parentElement!.dir = "rtl";
      const locale = chartLocale();
      configureChartLocale({
        ...locale,
        translate: (key, params) => key === "analysis.tpo.partial" ? "Partial חלקי" : locale.translate(key, params),
      });
      const step = series.config.priceStep;
      const mode = scenario === "letters" ? "letters" : "blocks";
      const collapsed = scenario === "collapsed" || scenario === "volume underlay";
      const underlay = scenario === "volume underlay" ? ["volume-profile"] : [];
      const from = 0;
      const to = series.length;
      const range: [number, number] = [from, to];
      const crosshair = { x: 0, y: 0, visible: true };
      runtime.setTpoMode(mode);
      runtime.setTpoProfilePeriod("daily");
      runtime.setTpoBracketSize("30m");
      settings.volumeProfile = underlay.length > 0;
      view.colWidth = collapsed ? 0.175 : 8.35;
      view.offsetX = 4.25;
      view.priceTop = 60_260;
      view.pricePerPx = collapsed ? 13 : 0.9;

      const reads = () => ctx.getImageData(0, 0, width, height).data;
      const production = (changes: number) =>
        overlay.renderAnnotations(view, series, crosshair, range, [...underlay, "tpo"], changes);
      const primeClosedPaint = () => {
        // The reference pass has a different layer order. Re-establish the
        // frame key, then capture the closed sessions at that same geometry.
        production(ChartChange.DataTail);
        production(ChartChange.DataTail);
      };
      const reuseCount = () => snapshotPerformanceTelemetry().counters["chart.annotation.pass.closed-tpo.reuse"] ?? 0;
      const pixelDiff = (actual: Uint8ClampedArray, expected: Uint8ClampedArray) => {
        let pixels = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] ||
            actual[i + 2] !== expected[i + 2] || actual[i + 3] !== expected[i + 3]) pixels++;
        }
        return pixels;
      };

      const referenceColors = new Set<string>();
      const referenceLabels = new Set<string>();
      let referenceRects = 0;
      let referenceLetters = 0;

      // Freeze the pre-change Canvas drawing order, colors, and geometry.
      // Build the profiles independently so the oracle also covers the updated tail.
      const reference = () => {
        overlay.renderAnnotations(view, series, crosshair, range, underlay);
        const { groups, brackets } = buildTpoProfileGroups(
          series.listReadonly(), from, to, "daily", 1_800_000, series.config.intervalMs, step, 0.7,
        );
        const top = view.area.top;
        const bottom = top + view.area.height;
        const mid = view.priceOfY((top + bottom) / 2);
        const cellH = Math.abs(view.yOfPrice(mid) - view.yOfPrice(mid + step));
        const letters = mode === "letters" && cellH >= 9 &&
          Math.min(...brackets.map((b) => view.xOfIndex(b.lastIdx + 1) - view.xOfIndex(b.firstIdx))) >= 8;
        const fillRect = (color: string, x: number, y: number, w: number, h: number) => {
          referenceColors.add(color);
          referenceRects++;
          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        };

        ctx.save();
        if (letters) {
          ctx.font = `${Math.min(11, cellH - 1)}px ui-monospace, Menlo, monospace`;
          ctx.textBaseline = "middle";
          ctx.textAlign = "center";
        }
        for (const group of groups) {
          const { result, firstIdx, lastIdx, firstBracketIndex, lastBracketIndex, partial } = group;
          const left = view.xOfIndex(firstIdx);
          const right = view.xOfIndex(lastIdx + 1);
          const latest = quantizeToStep(brackets[lastBracketIndex].bar.close, step);
          const countMax = Math.max(...result.levels.map((row) => row.count));
          const maxWidth = Math.max(8, view.colWidth, right - left);
          const square = Math.min(Math.max(cellH, 4), maxWidth / countMax);
          const block = cellH >= 2 && square >= 1.5;
          if (letters) {
            for (let i = firstBracketIndex; i <= lastBracketIndex; i++) {
              const bracket = brackets[i];
              const x = (view.xOfIndex(bracket.firstIdx) + view.xOfIndex(bracket.lastIdx + 1)) / 2;
              const low = quantizeToStep(bracket.bar.low, step);
              const high = quantizeToStep(bracket.bar.high, step);
              let bin = low;
              for (let tick = 0; tick <= Math.round((high - low) / step); tick++, bin = neighbourBin(bin, step, 1)) {
                const y = view.yOfPrice(bin + step / 2);
                if (y < top || y > bottom) continue;
                ctx.fillStyle = i === lastBracketIndex && bin === latest ? "#d8484f" : bin === result.poc ? "#e6c84f" : "#9fb4cc";
                referenceColors.add(ctx.fillStyle);
                referenceLetters++;
                ctx.fillText(tpoBracketLabel(i - firstBracketIndex), x, y);
              }
            }
          } else {
            if (!block) ctx.globalAlpha = 0.55;
            for (const row of result.levels) {
              const y = view.yOfPrice(row.priceBin + step);
              const yEnd = view.yOfPrice(row.priceBin);
              if (y > bottom || (block ? y + cellH : yEnd) < top) continue;
              const isPoc = row.priceBin === result.poc;
              const inVa = result.val !== null && result.vah !== null && row.priceBin >= result.val && row.priceBin <= result.vah;
              const base = isPoc ? "#e8edf4" : inVa ? "#3b6fd6" : "#5a6573";
              if (block) {
                for (const [position, bracketIndex] of row.bracketIndices.entries()) {
                  const x = left + position * square;
                  if (x - left > maxWidth) break;
                  let color = base;
                  if (row.priceBin === latest && bracketIndex === lastBracketIndex - firstBracketIndex) color = "#d8484f";
                  else if (!isPoc) {
                    const tone = [-0.2, -0.1, 0.03, -0.15, 0.07, -0.05][bracketIndex % 6];
                    color = "#" + [1, 3, 5].map((offset) => {
                      const channel = Number.parseInt(base.slice(offset, offset + 2), 16);
                      return Math.round(channel + ((tone < 0 ? 0 : 255) - channel) * Math.abs(tone)).toString(16).padStart(2, "0");
                    }).join("");
                  }
                  fillRect(color, x, y, Math.max(square - 1, 1), Math.max(cellH - 1, 1));
                }
              } else {
                fillRect(row.priceBin === latest ? "#d8484f" : base, left, y,
                  maxWidth * (row.count / countMax), Math.max(1, yEnd - y - 1));
              }
            }
            if (!block) ctx.globalAlpha = 1;
          }
          if (partial) {
            ctx.save();
            ctx.fillStyle = "#7aa8e0";
            ctx.font = "9px ui-monospace, Menlo, monospace";
            ctx.textAlign = "left";
            const label = tOr("analysis.tpo.partial");
            referenceLabels.add(label);
            ctx.fillText(label, Math.max(left + 3, view.area.left + 3), top + 12);
            ctx.restore();
          }
          for (const [price, label] of [[result.poc, "POC"], [result.vah, "VAH"], [result.val, "VAL"]] as const) {
            if (price === null) continue;
            const y = view.yOfPrice(price + step / 2);
            if (y < top || y > bottom) continue;
            const dashed = label !== "POC";
            const color = dashed ? "#7aa8e0" : "#ffffff";
            ctx.save();
            ctx.strokeStyle = color;
            ctx.globalAlpha = dashed ? 0.7 : 0.9;
            ctx.setLineDash(dashed ? [4, 3] : []);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right - 2, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            ctx.font = "9px ui-monospace, Menlo, monospace";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillStyle = color;
            referenceLabels.add(label);
            ctx.fillText(label, right + 1, y);
            ctx.restore();
          }
        }
        ctx.restore();
        return reads();
      };

      configurePerformanceTelemetry({ enabled: true });
      production(ChartChange.Viewport);
      const cold = reads();
      const hit = () => overlay.getTpoProfileAt(view.xOfIndex(1), view.area.top);
      const firstZone = hit();
      const coldDiff = pixelDiff(cold, reference());

      primeClosedPaint();
      const tail = series.at(series.length - 1)!;
      series.reassertOHLC(tail.startTime, tail.open, tail.high + 30, tail.low, {
        close: tail.high + 20, preferIncomingClose: true, observedAt: now,
      });
      production(ChartChange.DataTail);
      const retained = reads();
      const retainedZone = hit();
      const retainedCount = reuseCount();
      const retainedDiff = pixelDiff(retained, reference());

      primeClosedPaint();
      view.offsetX += 2.75;
      view.priceTop += 2.5;
      production(ChartChange.DataTail);
      const moved = reads();
      const movedCount = reuseCount();
      const movedDiff = pixelDiff(moved, reference());

      return {
        coldDiff, retainedDiff, movedDiff, retainedCount, movedCount, firstZone, retainedZone,
        colors: [...referenceColors], labels: [...referenceLabels], partial: tOr("analysis.tpo.partial"),
        referenceRects, referenceLetters,
      };
    }, { scenario, now: FROZEN_NOW });

    expect([result.coldDiff, result.retainedDiff, result.movedDiff]).toEqual([0, 0, 0]);
    expect(result.firstZone).toBeTruthy();
    expect(result.retainedZone).toEqual(result.firstZone);
    expect(result.retainedCount).toBe(scenario === "letters" || scenario === "volume underlay" ? 0 : 1);
    expect(result.movedCount).toBe(result.retainedCount);
    expect(result.labels).toEqual(expect.arrayContaining(["POC", "VAH", "VAL", result.partial]));
    expect(result.colors).toContain("#d8484f");
    if (scenario === "letters") {
      expect(result.referenceRects).toBe(0);
      expect(result.referenceLetters).toBeGreaterThan(0);
      expect(result.colors).toEqual(expect.arrayContaining(["#e6c84f", "#9fb4cc"]));
    } else {
      expect(result.referenceLetters).toBe(0);
      expect(result.referenceRects).toBeGreaterThan(0);
      expect(result.colors).toContain("#e8edf4");
      expect(result.colors).toContain(scenario === "blocks" ? "#2f59ab" : "#3b6fd6");
    }
  });
}
