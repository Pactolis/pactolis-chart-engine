import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decideLiveSameBarAutoFit } from "../dist/features/chart/liveAutoFit.js";

test("same-bar live autofit is skipped only when the cached viewport proves it safe", () => {
  const snapshot = { from: 10, to: 20, min: 90, max: 110 };

  assert.deepEqual(decideLiveSameBarAutoFit(null, { from: 10, to: 20 }, 19, 95, 105), { shouldAutoFit: true, reason: "no-snapshot" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 11, to: 21 }, 20, 95, 105), { shouldAutoFit: true, reason: "viewport-changed" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 10, to: 20 }, 25, 95, 105), { shouldAutoFit: false, reason: "tail-offscreen" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 10, to: 20 }, 19, 95, 105), { shouldAutoFit: false, reason: "contained" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 10, to: 20 }, 19, 95, 111), { shouldAutoFit: true, reason: "new-extrema" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 10, to: 20 }, 19, 89, 105), { shouldAutoFit: true, reason: "new-extrema" });
  assert.deepEqual(decideLiveSameBarAutoFit(snapshot, { from: 10, to: 20 }, 19, Number.NaN, 105), { shouldAutoFit: true, reason: "invalid-extrema" });
});

test("live update wiring gates only same-bar autoFit and snapshots raw visible extrema", async () => {
  const [history, runtime, autoscale] = await Promise.all([
    readFile(new URL("../src/features/chart/ChartHistoryController.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/core/model/footprintAutoscale.ts", import.meta.url), "utf8"),
  ]);

  assert.match(history, /event\.source === "live" && event\.kind === "same-bar-update"/);
  assert.match(history, /shouldAutoFitSameBarLiveUpdate\(\)/);
  assert.match(runtime, /decideLiveSameBarAutoFit\(this\.lastAutoFitSnapshot/);
  assert.match(runtime, /footprintVisiblePriceRange\(series, \{ from, to \}\)/);
  assert.match(runtime, /chart\.liveUpdate\.autoFit\.\$\{decision\.shouldAutoFit \? "fit" : "skip"\}/);
  assert.match(autoscale, /export function footprintVisiblePriceRange/);
});
