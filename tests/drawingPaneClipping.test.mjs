import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../src/features/chart/ChartRuntime.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function sliceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected source range: ${start}`);
  return source.slice(from, to);
}

function assertMainPlotClip(block) {
  assert.match(
    block,
    /ctx\.save\(\);[\s\S]*ctx\.beginPath\(\);[\s\S]*ctx\.rect\(activeView\.area\.left, activeView\.area\.top, activeView\.area\.width, activeView\.area\.height\);[\s\S]*ctx\.clip\(\);/,
  );
  assert.match(block, /ctx\.clip\(\);[\s\S]*finally \{\s*ctx\.restore\(\);\s*\}/);
}

test("annotation drawings are clipped to the main price plot", () => {
  const block = sliceBetween(
    "      (ctx, activeView, activeSeries) => {\n        const analysisCtx",
    "      () => this.analysisContextForChart().profileSettings,",
  );
  assertMainPlotClip(block);
  assert.match(block, /analysisCtx\.drawings\.renderAnalysis\(/);
  assert.match(block, /analysisCtx\.drawings\.render\(/);
});

test("selection anchors are clipped on the interaction surface", () => {
  const block = sliceBetween(
    "      (ctx, activeView, activeSeries) => {\n        const drawings",
    "    );\n\n    const view = this.view;",
  );
  assertMainPlotClip(block);
  assert.match(block, /drawings\.renderSelection\(/);
});

test("both physical drawing surfaces use activeView.area as the clip rectangle", () => {
  const clipRects = source.match(
    /ctx\.rect\(activeView\.area\.left, activeView\.area\.top, activeView\.area\.width, activeView\.area\.height\);/g,
  );
  assert.equal(clipRects?.length, 2);
});
