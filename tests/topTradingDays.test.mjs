import test from "node:test";
import assert from "node:assert/strict";
import {
  selectTopTradingDays,
  sortTradingDays,
} from "../dist/core/analysis/topTradingDays.js";

test("top trading days default sort is trade count desc then newer date first", () => {
  const rows = [
    { date: "2024-01-01", time: 0, tradeCount: 10, quoteVolume: 100, quoteVolumePerTrade: 10 },
    { date: "2024-01-02", time: 86_400_000, tradeCount: 10, quoteVolume: 120, quoteVolumePerTrade: 12 },
    { date: "2024-01-03", time: 2 * 86_400_000, tradeCount: 5, quoteVolume: 90, quoteVolumePerTrade: 18 },
  ];
  const sorted = sortTradingDays(rows, "tradeCount", "desc");
  assert.equal(sorted[0].date, "2024-01-02");
  assert.equal(sorted[1].date, "2024-01-01");
});

function row(index, overrides = {}) {
  const tradeCount = overrides.tradeCount ?? index + 1;
  const quoteVolume = overrides.quoteVolume ?? (301 - index) * 100;
  return {
    date: `day-${index}`,
    time: index * 86_400_000,
    tradeCount,
    quoteVolume,
    quoteVolumePerTrade: overrides.quoteVolumePerTrade ?? quoteVolume / tradeCount,
    ...overrides,
  };
}

test("selects and deduplicates independent top 100 rankings", () => {
  const rows = Array.from({ length: 300 }, (_, index) => row(index, {
    tradeCount: index + 1,
    quoteVolume: index < 100 ? 100_000 - index : index,
    quoteVolumePerTrade: index >= 100 && index < 200 ? 10_000 - index : index / 100,
  }));

  const selected = selectTopTradingDays(rows);
  assert.equal(selected.length, 300);
  assert.equal(new Set(selected.map((item) => item.time)).size, selected.length);
  assert.ok(selected.length <= 300);
});

test("overlapping rankings produce one row per day", () => {
  const rows = Array.from({ length: 150 }, (_, index) => row(index, {
    tradeCount: 1_000 - index,
    quoteVolume: 100_000 - index,
    quoteVolumePerTrade: 1_000 - index,
  }));

  const selected = selectTopTradingDays(rows);
  assert.equal(selected.length, 100);
  assert.equal(new Set(selected.map((item) => item.time)).size, 100);
});

test("ranking ties prefer newer days", () => {
  const rows = Array.from({ length: 101 }, (_, index) => row(index, {
    tradeCount: 10,
    quoteVolume: 10,
    quoteVolumePerTrade: 1,
  }));

  const selected = selectTopTradingDays(rows);
  assert.equal(selected.length, 100);
  assert.equal(selected.some((item) => item.time === 0), false);
  assert.equal(selected[0].time, 100 * 86_400_000);
});

test("zero-trade days cannot enter through the volume-per-trade ranking", () => {
  const valid = Array.from({ length: 100 }, (_, index) => row(index, {
    tradeCount: 1,
    quoteVolume: 1,
    quoteVolumePerTrade: index + 1,
  }));
  const zeroTrade = Array.from({ length: 100 }, (_, index) => row(index + 100, {
    tradeCount: 0,
    quoteVolume: 0,
    quoteVolumePerTrade: Number.POSITIVE_INFINITY,
  }));

  const selected = selectTopTradingDays([...valid, ...zeroTrade]);
  assert.equal(selected.filter((item) => item.tradeCount === 0).length, 0);
  assert.equal(selected.length, 100);
});

test("date descending sort is suitable for the modal default", () => {
  const rows = [row(1), row(3), row(2)];
  assert.deepEqual(
    sortTradingDays(rows, "date", "desc").map((item) => item.time),
    [3, 2, 1].map((day) => day * 86_400_000)
  );
});

test("liqTotalUsd ranking includes the highest-liq day even when ranked low by other metrics", () => {
  // 100 days ranked highest by tradeCount/volume (time 0-99)
  const tradeTopDays = Array.from({ length: 100 }, (_, i) => ({
    date: `trade-${i}`, time: i * 86_400_000,
    tradeCount: 1_000_000, quoteVolume: 1_000_000_000, quoteVolumePerTrade: 1000,
    // No liq data
  }));
  // 1 extra day with zero trade metrics but highest liq — only enters via liqTotalUsd
  const liqOnlyDay = {
    date: "liq-only", time: 5000 * 86_400_000,
    tradeCount: 1, quoteVolume: 1, quoteVolumePerTrade: 1,
    liqTotalUsd: 999_999_999, liqBuyUsd: 600_000_000, liqSellUsd: 399_999_999,
  };

  const selected = selectTopTradingDays([...tradeTopDays, liqOnlyDay]);
  // The liqOnlyDay must be present because it tops the liqTotalUsd ranking
  assert.ok(selected.some((d) => d.time === liqOnlyDay.time));
  // No duplicates
  assert.equal(new Set(selected.map((d) => d.time)).size, selected.length);
});

test("days without liqTotalUsd cannot enter through the liq ranking", () => {
  const noLiq = Array.from({ length: 200 }, (_, i) => row(i));
  const withLiq = Array.from({ length: 100 }, (_, i) =>
    row(i + 200, { liqTotalUsd: i + 1, liqBuyUsd: (i + 1) * 0.6, liqSellUsd: (i + 1) * 0.4 })
  );

  const selected = selectTopTradingDays([...noLiq, ...withLiq]);
  // All 100 liq days should be included, and the 100 best noLiq days
  const liqSelected = selected.filter((d) => d.liqTotalUsd != null);
  assert.equal(liqSelected.length, 100);
  // No duplicates
  assert.equal(new Set(selected.map((d) => d.time)).size, selected.length);
});

test("liqTotalUsd sort handles undefined as 0", () => {
  const rows = [
    row(0, { liqTotalUsd: undefined }),
    row(1, { liqTotalUsd: 5000 }),
    row(2, { liqTotalUsd: 1000 }),
    row(3),
  ];
  const sorted = sortTradingDays(rows, "liqTotalUsd", "desc");
  assert.equal(sorted[0].time, 1 * 86_400_000); // 5000
  assert.equal(sorted[1].time, 2 * 86_400_000); // 1000
  // The two undefined rows (time=0 and time=3*DAY) come last, newer first
  assert.equal(sorted[2].time, 3 * 86_400_000);
  assert.equal(sorted[3].time, 0);
});

test("selectTopTradingDays with liq never produces duplicate dates", () => {
  // Day that ranks top in ALL 4 categories
  const superDay = row(999, {
    tradeCount: 1_000_000,
    quoteVolume: 1_000_000_000,
    quoteVolumePerTrade: 10_000,
    liqTotalUsd: 5_000_000_000,
    liqBuyUsd: 3_000_000_000,
    liqSellUsd: 2_000_000_000,
  });
  const rest = Array.from({ length: 300 }, (_, i) =>
    row(i, {
      tradeCount: i + 1,
      quoteVolume: i * 100,
      quoteVolumePerTrade: i / 10,
      liqTotalUsd: i * 50,
      liqBuyUsd: i * 30,
      liqSellUsd: i * 20,
    })
  );

  const selected = selectTopTradingDays([superDay, ...rest]);
  const times = selected.map((d) => d.time);
  assert.equal(new Set(times).size, times.length, "no duplicate dates");
  // superDay appears exactly once
  assert.equal(times.filter((t) => t === superDay.time).length, 1);
});
