import test from "node:test";
import assert from "node:assert/strict";
import { ichimokuCloudSegments } from "../dist/features/indicators/builtins/ichimokuCloud.js";

const point = (index, value) => ({ index, time: index * 1000, value });

test("Ichimoku cloud segments classify bullish and bearish spans", () => {
  const segments = ichimokuCloudSegments(
    [point(0, 12), point(1, 14), point(2, 8)],
    [point(0, 10), point(1, 11), point(2, 12)],
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].bullish, true);
  assert.equal(segments[1].bullish, false);
});

test("Ichimoku cloud segments do not bridge null or non-adjacent points", () => {
  const segments = ichimokuCloudSegments(
    [point(0, 12), point(1, null), point(3, 14), point(4, 15)],
    [point(0, 10), point(1, 11), point(3, 12), point(4, 13)],
  );
  assert.deepEqual(segments.map((segment) => [segment.fromIndex, segment.toIndex]), [[3, 4]]);
});
