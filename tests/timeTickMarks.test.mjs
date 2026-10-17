import test from "node:test";
import assert from "node:assert/strict";
import { TickMarkWeight } from "../dist/core/model/timeScale.js";
import { TimeTickMarks } from "../dist/core/model/timeTickMarks.js";

function point(index, weight = TickMarkWeight.Minute1, whitespace = false) {
  return {
    index,
    time: Date.UTC(2026, 5, 23, 8, index),
    timeWeight: weight,
    whitespace,
  };
}

test("time tick marks ignore projected whitespace when the option is enabled", () => {
  const builder = new TimeTickMarks({ uniformDistribution: false, ignoreWhitespaceIndices: true });
  const marks = builder.build([point(0), point(2, TickMarkWeight.Minute1, true), point(4)], 10, 10);
  assert.deepEqual(marks.map((mark) => mark.index), [0, 4]);
});

test("time tick marks allow projected whitespace when the option is disabled", () => {
  const builder = new TimeTickMarks({ uniformDistribution: false, ignoreWhitespaceIndices: false });
  const marks = builder.build([point(0), point(2, TickMarkWeight.Minute1, true), point(4)], 10, 10);
  assert.deepEqual(marks.map((mark) => mark.index), [0, 2, 4]);
});

test("uniform time tick distribution keeps same-weight marks as all-or-none groups", () => {
  const nonUniform = new TimeTickMarks({ uniformDistribution: false, ignoreWhitespaceIndices: false });
  const uniform = new TimeTickMarks({ uniformDistribution: true, ignoreWhitespaceIndices: false });
  const points = [
    point(0, TickMarkWeight.Day),
    point(2, TickMarkWeight.Hour1),
    point(3, TickMarkWeight.Hour1),
    point(9, TickMarkWeight.Hour1),
  ];

  assert.deepEqual(nonUniform.build(points, 10, 20).map((mark) => mark.index), [0, 2, 9]);
  assert.deepEqual(uniform.build(points, 10, 20).map((mark) => mark.index), [0]);
});

test("sub-pixel bar spacing still enforces the label pixel budget", () => {
  const builder = new TimeTickMarks({ uniformDistribution: false, ignoreWhitespaceIndices: false });
  const spacing = 0.19125;
  const maxLabelWidth = 75;
  const points = Array.from({ length: 2_000 }, (_, index) => point(index));
  const marks = builder.build(points, spacing, maxLabelWidth);

  for (let index = 1; index < marks.length; index += 1) {
    const pixelDistance = (marks[index].index - marks[index - 1].index) * spacing;
    assert.ok(pixelDistance >= maxLabelWidth,
      `labels are only ${pixelDistance}px apart at sub-pixel zoom`);
  }
});
