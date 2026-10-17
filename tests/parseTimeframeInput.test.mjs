import test from "node:test";
import assert from "node:assert/strict";
import { nextTimeframeInputState, parseTimeframeInput } from "../dist/features/chart/parseTimeframeInput.js";

test("parseTimeframeInput mapping", () => {
  assert.equal(parseTimeframeInput("1"), "1m");
  assert.equal(parseTimeframeInput("5"), "5m");
  assert.equal(parseTimeframeInput("30"), "30m");
  assert.equal(parseTimeframeInput("60"), "1h");
  assert.equal(parseTimeframeInput("120"), "2h");
  assert.equal(parseTimeframeInput("240"), "4h");
  assert.equal(parseTimeframeInput("1440"), "1d");
  assert.equal(parseTimeframeInput("1h"), "1h");
  assert.equal(parseTimeframeInput("1H"), "1h");
  assert.equal(parseTimeframeInput("1D"), "1d");
  assert.equal(parseTimeframeInput("1d"), "1d");
  assert.equal(parseTimeframeInput("3d"), "3d");
  assert.equal(parseTimeframeInput("1w"), "1w");
  assert.equal(parseTimeframeInput("1W"), "1w");
  assert.equal(parseTimeframeInput("1M"), "1M");
  assert.equal(parseTimeframeInput("1m"), "1m");
  assert.equal(parseTimeframeInput("5m"), "5m");
  assert.equal(parseTimeframeInput("15m"), "15m");
  assert.equal(parseTimeframeInput("60m"), "1h");
  assert.equal(parseTimeframeInput("2M"), "2M");
  assert.equal(parseTimeframeInput("2m"), null);
  assert.equal(parseTimeframeInput("6M"), "6M");
  assert.equal(parseTimeframeInput("10"), null);
  assert.equal(parseTimeframeInput("125"), null);
  assert.equal(parseTimeframeInput("1aaaaa"), null);
  assert.equal(parseTimeframeInput("30s"), null);
  assert.equal(parseTimeframeInput("abc"), null);
  assert.equal(parseTimeframeInput("0"), null);
  assert.equal(parseTimeframeInput(""), null);
});

function runKeys(events) {
  let state = { buffer: "", invalid: false };
  let submission = null;
  for (const event of events) {
    const transition = nextTimeframeInputState(state, typeof event === "string" ? { key: event } : event);
    state = transition.state;
    if (transition.submission) submission = transition.submission;
  }
  return { state, submission };
}

test("timeframe keyboard input is case-insensitive for CapsLock-style unit keys", () => {
  assert.deepEqual(runKeys(["1", "H", "Enter"]).submission, { raw: "1H", label: "1h" });
  assert.deepEqual(runKeys(["1", "D", "Enter"]).submission, { raw: "1D", label: "1d" });
  assert.deepEqual(runKeys(["1", "W", "Enter"]).submission, { raw: "1W", label: "1w" });
});

test("timeframe keyboard input keeps m for minutes and M for months, like chart labels", () => {
  assert.deepEqual(runKeys(["5", "m", "Enter"]).submission, { raw: "5m", label: "5m" });
  assert.deepEqual(runKeys(["1", "m", "Enter"]).submission, { raw: "1m", label: "1m" });
  assert.deepEqual(runKeys(["1", "M", "Enter"]).submission, { raw: "1M", label: "1M" });
});

test("timeframe keyboard input rejects invalid buffered text instead of applying the prefix", () => {
  const result = runKeys(["1", "a", "a", "a", "a", "a", "Enter"]);
  assert.deepEqual(result.submission, { raw: "1", label: null });
  assert.deepEqual(result.state, { buffer: "", invalid: false });
});

test("timeframe keyboard input allows at most one unit letter after the number", () => {
  const first = nextTimeframeInputState({ buffer: "1h", invalid: false }, { key: "h" });
  assert.equal(first.handled, true);
  assert.deepEqual(first.state, { buffer: "1h", invalid: true });

  const result = runKeys(["1", "h", "h", "x", "Enter"]);
  assert.deepEqual(result.submission, { raw: "1h", label: null });
  assert.deepEqual(result.state, { buffer: "", invalid: false });
});

test("timeframe keyboard input ignores modified shortcuts", () => {
  const state = { buffer: "", invalid: false };
  const transition = nextTimeframeInputState(state, { key: "1", ctrlKey: true });
  assert.equal(transition.handled, false);
  assert.equal(transition.submission, undefined);
  assert.deepEqual(transition.state, state);
});
