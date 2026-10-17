import test from "node:test";
import assert from "node:assert/strict";
import { retainPendingTimeframeAnchor, sameHistorySelection } from "../dist/core/historySelection.js";

test("rapid timeframe changes accept only the final selection snapshot", () => {
  const common = {
    markets: ["BINANCE_FUTURES:btcusdt"],
    reference: "BINANCE_FUTURES:btcusdt",
    priceStep: 10,
  };
  const minute = { ...common, intervalMs: 60_000 };
  const hour = { ...common, intervalMs: 3_600_000 };
  const day = { ...common, intervalMs: 86_400_000 };

  assert.equal(sameHistorySelection(minute, day), false);
  assert.equal(sameHistorySelection(hour, day), false);
  assert.equal(sameHistorySelection(day, day), true);
});

test("rapid timeframe changes retain the last measurable viewport anchor while the series is empty", () => {
  const originalCenter = Date.UTC(2026, 6, 18, 8);

  const captured = retainPendingTimeframeAnchor(null, originalCenter);
  const retainedAfterSeriesClear = retainPendingTimeframeAnchor(captured, null);
  const replacedByNewMeasurement = retainPendingTimeframeAnchor(retainedAfterSeriesClear, originalCenter + 60_000);

  assert.equal(retainedAfterSeriesClear, originalCenter);
  assert.equal(replacedByNewMeasurement, originalCenter + 60_000);
});
