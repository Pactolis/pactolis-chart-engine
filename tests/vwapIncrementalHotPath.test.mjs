import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("VWAP tail incremental path is limited to current unbanded lines and keeps full fallback", async () => {
  const source = await read("src/features/indicators/builtins/vwapIndicator.ts");

  assert.match(source, /lines\.every\(\(line\) => line\.family === "current" && !line\.showBands\)/);
  assert.match(source, /indicatorPriceSeriesMutation\(ctx\.series\)/);
  assert.match(source, /mutation\.kind === "metadata"/);
  assert.match(source, /mutation\.kind === "tail"/);
  assert.doesNotMatch(source, /cached\.structureRevision === ctx\.series\.structureRevision/);
  assert.match(source, /state\.periodStart === calendarPeriodStart\(tail\.startTime, lines\[index\]\.period\)/);
  assert.match(source, /indicator\.prepare\.incremental\.vwap/);
  assert.match(source, /indicator\.incremental\.hit\.vwap/);
  assert.match(source, /indicator\.prepare\.full\.vwap/);
  assert.match(source, /indicator\.incremental\.full\.vwap/);
  assert.match(source, /calculateVwapSeries\(bars, lines\.map\(definitionForLine\)\)/);
});
