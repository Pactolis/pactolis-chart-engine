import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("initial history rejection is owned without console warning or error spam", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/features/chart/ChartRuntime.ts");
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /const initialHistoryLoad = runtime\.loadHistory\(undefined, \{ twoPhase: true \}\);/);
  assert.match(source, /void initialHistoryLoad\.catch\(\(\) => undefined\);/);
  assert.doesNotMatch(source, /initialHistoryLoad\.catch\([\\s\\S]{0,180}console\.(?:warn|error)/);
});

test("history requests start on a bucket boundary", async () => {
  // The load moved into ChartHistoryController when ChartRuntime was decomposed.
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/features/chart/ChartHistoryController.ts");
  const source = fs.readFileSync(file, "utf8");
  // The backend reads footprint from the requested `from`, so an unaligned value
  // leaves the oldest visible bar with partial cells (or none on the base interval).
  assert.match(
    source,
    /const from = Math\.max\(\s*0,\s*bucketStart\(\s*Math\.max\(0, to - resolvedIntervalMs \* chartDataSource\(\)\.initialHistoryBars\),\s*resolvedIntervalMs,\s*\),\s*\);/,
  );

  const { bucketStart } = await import("../dist/core/time.js");
  const now = Date.UTC(2024, 5, 13, 9, 41, 17);
  for (const interval of [60_000, 300_000, 3_600_000, 86_400_000, 7 * 86_400_000]) {
    const rawFrom = bucketStart(Math.max(0, now - interval * 4000), interval);
    const from = Math.max(0, rawFrom);
    if (from > 0) {
      assert.equal(bucketStart(from, interval), from, `interval ${interval} is not idempotent`);
    } else {
      assert.equal(from, 0);
    }
  }
});
