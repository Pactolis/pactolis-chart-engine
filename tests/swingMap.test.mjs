import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMarketStructure,
  detectSwings,
  IncrementalMarketStructure,
  IncrementalSwingDetector,
  resolveStructuralSwings,
} from "../dist/core/analysis/swings.js";
import { swingMapIndicatorDefinition as definition } from "../dist/features/indicators/builtins/swingMap.js";
import { FootprintSeries } from "../dist/core/model/footprint.js";
import { createIndicatorInstance } from "../dist/features/indicators/registry.js";

// Hand-authored alternating extrema; price changes exercise HH/HL/LH/LL.
const prices = [5, 10, 6, 12, 7, 9, 4, 8, 3, 7, 5];
const bars = prices.map((price, i) => ({ startTime: i * 60_000, open: price, high: price + 1, low: price - 1,
  close: price, volume: 1, delta: 0, count: 1, cells: new Map(), hasRef: true }));
const expected = [
  { index: 1, price: 11, kind: "high", confirmedAtIndex: 2 },
  { index: 2, price: 5, kind: "low", confirmedAtIndex: 3 },
  { index: 3, price: 13, kind: "high", confirmedAtIndex: 4 },
  { index: 4, price: 6, kind: "low", confirmedAtIndex: 5 },
  { index: 5, price: 10, kind: "high", confirmedAtIndex: 6 },
  { index: 6, price: 3, kind: "low", confirmedAtIndex: 7 },
  { index: 7, price: 9, kind: "high", confirmedAtIndex: 8 },
  { index: 8, price: 2, kind: "low", confirmedAtIndex: 9 },
  { index: 9, price: 8, kind: "high", confirmedAtIndex: 10 },
];
function context(data = bars, settings = {}) {
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(structuredClone(data));
  const instance = createIndicatorInstance("swing-map", 0);
  instance.settings = { ...instance.settings, left: 1, right: 1, ...settings };
  return { ctx: {}, view: {}, rect: { top: 0, height: 300 }, range: [0, data.length], series, instance, settings: instance.settings, requestRefresh() {} };
}

test("pure swing detector matches hand-authored pivots and confirmation indices", () => {
  assert.deepEqual(detectSwings(bars, 1, 1), expected);
  assert.deepEqual(detectSwings([], 5, 5), []);
  assert.deepEqual(detectSwings([{ high: 10, low: 5 }], 1, 1), []);
  const plateau = [{ high: 1, low: 0 }, { high: 3, low: 1 }, { high: 3, low: 2 }, { high: 2, low: 1 }];
  assert.deepEqual(detectSwings(plateau, 1, 1).filter((pivot) => pivot.kind === "high").map((pivot) => pivot.index), [1]);
});

test("bar-by-bar growth never exposes a pivot before confirmation or changes a confirmed pivot", () => {
  let previous = [];
  for (let length = 1; length <= bars.length; length++) {
    const result = detectSwings(bars.slice(0, length), 1, 1);
    assert.ok(result.every((pivot) => pivot.confirmedAtIndex < length));
    for (const pivot of previous) assert.ok(result.some((item) => JSON.stringify(item) === JSON.stringify(pivot)));
    assert.deepEqual(result, expected.filter((pivot) => pivot.confirmedAtIndex < length));
    previous = result;
  }
});

test("incremental append and mutable-tail results exactly equal full scan with bounded windows", () => {
  const detector = new IncrementalSwingDetector();
  const stream = [];
  for (const bar of bars) {
    stream.push({ ...bar });
    assert.deepEqual(detector.update(stream, 1, 1, "append"), detectSwings(stream, 1, 1));
    const before = detector.evaluatedWindows;
    const saved = stream.at(-1).high;
    stream.at(-1).high += 2;
    assert.deepEqual(detector.update(stream, 1, 1, "tail"), detectSwings(stream, 1, 1));
    assert.ok(detector.evaluatedWindows - before <= 1, "one final left+right window per tail tick");
    stream.at(-1).high = saved;
    assert.deepEqual(detector.update(stream, 1, 1, "tail"), detectSwings(stream, 1, 1));
  }
});

test("Swing Map labels use earlier same-kind pivots, retain offscreen history and apply step tolerance", () => {
  const ctx = context();
  assert.deepEqual(definition.prepareData(ctx).points.map((point) => point.label), ["H", "L", "HH", "HL", "LH", "LL", "LH", "LL"]);
  ctx.range = [5, bars.length];
  assert.equal(definition.prepareData(ctx).points[0].label, "LH", "classification retains offscreen previous high");
  const equal = context(bars.map((bar, i) => i === 3 ? { ...bar, high: 11.5, open: 11.25, close: 11.25 } : bar), { equalityToleranceSteps: 1 });
  assert.ok(!definition.prepareData(equal).points.some((point) => point.index === 3), "same-price marker within one priceStep is not repeated");
});

test("replay as-of excludes future bars and includes only completed confirmation bars", () => {
  const ctx = context();
  for (let closed = 0; closed <= bars.length; closed++) {
    ctx.chart = { market: "BINANCE_FUTURES:btcusdt", timeframe: "1m", intervalMs: 60_000, asOfTime: closed * 60_000 };
    const result = definition.prepareData(ctx).points;
    assert.deepEqual(result.map(({ label, ...pivot }) => pivot), expected.filter((pivot) => pivot.confirmedAtIndex < closed));
  }
  ctx.chart.asOfTime = 4 * 60_000;
  assert.deepEqual(definition.prepareData(ctx).points.map((point) => point.index), [1, 2], "backward seek discards future pivots");
});

test("live open-bar ticks cannot confirm or repaint existing pivots and do not rescan history", () => {
  const ctx = context();
  const before = definition.prepareData(ctx);
  for (let i = 0; i < 5; i++) {
    ctx.series.addTrades([{ time: 10 * 60_000 + i + 1, price: 100 + i, qty: 1, isBuy: true, id: `live-${i}` }]);
    const after = definition.prepareData(ctx);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.meta.evaluatedWindows, before.meta.evaluatedWindows);
  }
});

test("unconfirmed candidates are opt-in, faint and explicitly labeled; visible pivots alone paint", () => {
  const ctx = context(bars.slice(0, 4));
  assert.equal(definition.defaultSettings().showUnconfirmed, false);
  assert.ok(definition.prepareData(ctx).points.every((point) => !point.unconfirmed));
  ctx.settings.showUnconfirmed = true;
  const prepared = definition.prepareData(ctx);
  assert.ok(prepared.points.some((point) => point.unconfirmed && point.label.includes("unconfirmed")));
  const marks = [];
  const labels = [];
  ctx.view = { area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 10, xOfIndex: (i) => i * 10, yOfPrice: (p) => 400 - p };
  ctx.ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, globalAlpha: 1,
    fillRect(...args) { marks.push({ alpha: this.globalAlpha, args }); }, fillText(text) { labels.push(text); } };
  definition.drawPriceOverlay(ctx, prepared);
  assert.equal(marks.length, prepared.points.length);
  assert.ok(marks.some((mark) => mark.alpha === 0.35));
  assert.ok(labels.includes("H? (unconfirmed)"));
});

function makeOhlcBars(specs, startTime = 0, intervalMs = 60_000) {
  return specs.map(([open, high, low, close], i) => ({
    startTime: startTime + i * intervalMs,
    open,
    high,
    low,
    close,
    volume: 10,
    delta: close >= open ? 2 : -2,
    count: 5,
    cells: new Map(),
    hasRef: true,
  }));
}

function makeSimpleBars(highsLowsCloses, startTime = 0, intervalMs = 60_000) {
  return highsLowsCloses.map(([high, low, close = (high + low) / 2], i) => ({
    startTime: startTime + i * intervalMs,
    open: close,
    high,
    low,
    close,
    volume: 10,
    delta: 0,
    count: 5,
    cells: new Map(),
    hasRef: true,
  }));
}

function makeRichCanvas() {
  const lines = [];
  const rects = [];
  const texts = [];
  const arcs = [];
  let dash = [];
  return {
    lines,
    rects,
    texts,
    arcs,
    ctx: {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      textAlign: "left",
      _x: 0,
      _y: 0,
      setLineDash(next) { dash = [...next]; },
      moveTo(x, y) { this._x = x; this._y = y; },
      lineTo(x, y) { lines.push({ x1: this._x, y1: this._y, x2: x, y2: y, dash: [...dash], color: this.strokeStyle, alpha: this.globalAlpha }); },
      stroke() {},
      arc(x, y, r) { arcs.push({ x, y, r, color: this.strokeStyle, alpha: this.globalAlpha }); },
      fillRect(...args) { rects.push({ alpha: this.globalAlpha, color: this.fillStyle, args }); },
      fillText(text, x, y) { texts.push({ text, x, y, color: this.fillStyle, alpha: this.globalAlpha }); },
    },
  };
}

test("Scenario 1 & 2: alternating structural swings pick most extreme candidate and finalize only on opposite pivot", () => {
  // Raw pivots (L=1,R=1): H(1,12), H(3,16), L(5,6), H(7,14), L(9,8)
  const bars1 = makeSimpleBars([
    [10, 8], [12, 9], [10, 8], [16, 10], [11, 8], [10, 6], [11, 8], [14, 9], [11, 9], [10, 8], [12, 10],
  ]);
  // Before L(5) confirms at index 6, H(3,16) replaces H(1,12) and remains provisional.
  const at5 = analyzeMarketStructure(bars1, { left: 1, right: 1 }, 6);
  assert.equal(at5.swings.length, 1);
  assert.equal(at5.swings[0].pivotIndex, 3);
  assert.equal(at5.swings[0].price, 16);
  assert.equal(at5.swings[0].status, "provisional");
  assert.equal(at5.swings[0].structuralFinalizedAtIndex, null);

  // At closedLength=7 (index 6 confirms L(5,6)), H(3,16) becomes finalized at 6.
  const at6 = analyzeMarketStructure(bars1, { left: 1, right: 1 }, 7);
  assert.equal(at6.swings.length, 2);
  assert.equal(at6.swings[0].status, "finalized");
  assert.equal(at6.swings[0].structuralFinalizedAtIndex, 6);
  assert.equal(at6.swings[1].kind, "low");
  assert.equal(at6.swings[1].status, "provisional");

  const full1 = analyzeMarketStructure(bars1, { left: 1, right: 1 });
  assert.deepEqual(full1.swings.map((s) => s.kind), ["high", "low", "high", "low"]);
  assert.deepEqual(full1.swings.map((s) => s.price), [16, 6, 14, 8]);
  assert.deepEqual(full1.swings.map((s) => s.label), ["H", "L", "LH", "HL"]);

  // Scenario 2: L, L(lower), H, L -> picks lowest candidate for low.
  const bars2 = makeSimpleBars([
    [12, 10], [11, 8], [12, 9], [10, 4], [11, 7], [15, 9], [12, 8], [11, 7], [13, 9],
  ]);
  const full2 = analyzeMarketStructure(bars2, { left: 1, right: 1 });
  assert.deepEqual(full2.swings.map((s) => [s.kind, s.price]), [["low", 4], ["high", 15], ["low", 7]]);
  assert.equal(full2.swings[0].status, "finalized");
  assert.equal(full2.swings[0].structuralFinalizedAtIndex, 6);
});

test("equal-price tolerance tie-break deterministically keeps first-formed swing", () => {
  const raw = [
    { index: 2, price: 100, kind: "high", confirmedAtIndex: 4 },
    { index: 6, price: 100.5, kind: "high", confirmedAtIndex: 8 },
    { index: 10, price: 90, kind: "low", confirmedAtIndex: 12 },
    { index: 14, price: 100.2, kind: "high", confirmedAtIndex: 16 },
  ];
  const { swings } = resolveStructuralSwings(raw, 1);
  assert.equal(swings.length, 3);
  assert.equal(swings[0].pivotIndex, 2);
  assert.equal(swings[0].price, 100);
  assert.equal(swings[2].label, "EQH");
});

test("Scenario 3, 4, 5, 6: unknown initial suppression, HH+HL -> Bullish BOS, wick sweep vs CHoCH close, transition gating", () => {
  // Sequence (L=1, R=1):
  // 0: [12,10,11]
  // 1: H0=20 (conf@2), 2: [16,13,14], 3: L0=10 (conf@4), 4: [18,12,17]
  // 5: H1=25 (HH, conf@6), 6: [22,18,19], 7: L1=15 (HL, conf@8) -> bullish established at 8! (PL=15, targetHigh=25)
  // 8: [21,16,20], 9: [26,20,25] (wick above 25, close=25 -> NOT break in close mode!),
  // 10: [28,24,27] -> Bullish BOS #1 at 10!
  // 11: [27,24,26], 12: [24,14,17] (wick below PL=15 to 14, close=17 -> sweep only, NOT CHoCH!),
  // 13: [18,13,13.5] -> close below PL=15 -> Bearish CHoCH at 13 -> trend becomes "transition"!
  // 14: [14,11,11.5], 15: L2=9 (conf@16), 16: [13,10,12] -> close 11.5/12 while in transition: NO Bearish BOS!
  // 17: H2=18 (LH, conf@18), 18: [16,13,14] -> at 18, LL(9)+LH(18) confirms bearish! (PH=18, targetLow=9)
  // 19: [14,8,8.5] -> Bearish BOS at 19!
  // 20: [19,9,18.5] -> close above PH=18 -> Bullish CHoCH at 20 -> trend becomes "transition"!
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 26, 20, 25], // bar 9: wick > 25, close == 25 (sweep)
    [25, 28, 24, 27], // bar 10: close > 25 -> Bullish BOS
    [26, 27, 24, 26],
    [25, 24, 14, 17], // bar 12: wick < 15, close > 15 (sweep)
    [17, 18, 13, 13.5], // bar 13: close < 15 -> Bearish CHoCH -> transition
    [13.5, 14, 11, 11.5],
    [11.5, 12, 9, 10], // bar 15: L2=9 (conf@16)
    [10, 13, 10, 12], // bar 16: L2 confirms (still transition, no LH yet)
    [12, 18, 11, 16], // bar 17: H2=18 (LH, conf@18)
    [16, 16, 13, 14], // bar 18: H2 confirms -> bearish trend confirmed
    [14, 14, 8, 8.5], // bar 19: close < 9 -> Bearish BOS
    [8.5, 19, 9, 18.5], // bar 20: close > 18 -> Bullish CHoCH -> transition
  ]);

  const res = analyzeMarketStructure(bars, { left: 1, right: 1, equalityTolerance: 0, breakConfirmation: "close" });

  // Before bar 8, trend is unknown and no break events exist.
  const preBull = analyzeMarketStructure(bars, { left: 1, right: 1 }, 8);
  assert.equal(preBull.trend, "unknown");
  assert.equal(preBull.breakEvents.length, 0);

  // At bar 8 (closedLength=9), bullish trend is established.
  const atBull = analyzeMarketStructure(bars, { left: 1, right: 1 }, 9);
  assert.equal(atBull.trend, "bullish");
  assert.equal(atBull.activeProtectedLow?.price, 15);
  assert.equal(atBull.activeSwingHigh?.price, 25);

  // Bar 9 wick does not trigger BOS; bar 10 close triggers 1 Bullish BOS.
  const atBar9 = analyzeMarketStructure(bars, { left: 1, right: 1 }, 10);
  assert.equal(atBar9.breakEvents.length, 0);
  assert.equal(atBar9.sweepCandidates.length, 1);
  assert.equal(atBar9.sweepCandidates[0].barIndex, 9);

  // After CHoCH at bar 13, bar 14..17 stay in transition with zero BOS.
  const atBar17 = analyzeMarketStructure(bars, { left: 1, right: 1 }, 18);
  assert.equal(atBar17.trend, "transition");
  assert.deepEqual(
    atBar17.breakEvents.map((e) => [e.kind, e.direction, e.breakIndex]),
    [["BOS", "bullish", 10], ["CHoCH", "bearish", 13]],
  );

  // Full result includes Bearish BOS at 19 and Bullish CHoCH at 20.
  assert.deepEqual(
    res.breakEvents.map((e) => [e.kind, e.direction, e.breakIndex, e.levelPrice]),
    [
      ["BOS", "bullish", 10, 25],
      ["CHoCH", "bearish", 13, 15],
      ["BOS", "bearish", 19, 9],
      ["CHoCH", "bullish", 20, 18],
    ],
  );
  assert.equal(res.trend, "transition");
  // Both bar 9 (high sweep) and bar 12 (low sweep) were separated as sweep candidates.
  assert.deepEqual(res.sweepCandidates.map((s) => [s.kind, s.barIndex]), [["high", 9], ["low", 12]]);
});

test("wick mode fires on wick breach, single-fire per level, and gap candle triggers cleanly", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 26, 20, 24], // wick above 25, close 24 -> fires in wick mode!
    [24, 29, 23, 28], // subsequent break above already-broken 25 -> must NOT fire duplicate BOS
    [28, 29, 25, 27],
  ]);

  const wickRes = analyzeMarketStructure(bars, { left: 1, right: 1, breakConfirmation: "wick" });
  assert.deepEqual(
    wickRes.breakEvents.map((e) => [e.kind, e.direction, e.confirmation, e.breakIndex]),
    [["BOS", "bullish", "wick", 9]],
  );

  // Gap candle test: gap directly from close=20 to open=30, high=31, low=29, close=30.5
  const gapBars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [30, 31, 29, 30.5], // gap above 25
  ]);
  const gapRes = analyzeMarketStructure(gapBars, { left: 1, right: 1, breakConfirmation: "close" });
  assert.deepEqual(
    gapRes.breakEvents.map((e) => [e.kind, e.direction, e.breakIndex]),
    [["BOS", "bullish", 9]],
  );
});

test("nested minor pullbacks do not prematurely raise protectedLow or cause false CHoCH", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19], // H0=20
    [18, 16, 13, 14],
    [14, 15, 10, 12], // L0=10
    [12, 18, 12, 17],
    [17, 25, 16, 23], // H1=25 (HH)
    [23, 22, 18, 19],
    [19, 20, 14, 18], // L1=14 (HL) -> bullish (PL=14, target=25)
    [18, 21, 16, 20],
    [20, 27, 20, 26], // bar 9: BOS #1 above 25
    [26, 30, 25, 28], // bar 10: H2=30 (conf@11)
    [28, 28, 24, 25],
    [25, 26, 22, 24], // bar 12: L2=22 minor pullback low (conf@13)
    [24, 27, 23, 26],
    [26, 28, 24, 25], // bar 14: minor LH=28 (<30, conf@15)
    [25, 26, 19, 20], // bar 15: drops below minor L2=22 to 19 (still > PL=14!)
    [20, 25, 19.5, 24],
    [24, 32, 24, 31], // bar 17: BOS #2 above H2=30 -> promotes PL to 19 (lowest pullback low)!
  ]);
  const res = analyzeMarketStructure(bars, { left: 1, right: 1 });
  assert.deepEqual(
    res.breakEvents.map((e) => [e.kind, e.direction, e.breakIndex, e.levelPrice]),
    [
      ["BOS", "bullish", 9, 25],
      ["BOS", "bullish", 17, 30],
    ],
  );
  assert.equal(res.trend, "bullish");
  assert.equal(res.activeProtectedLow?.price, 19);
});

test("Scenario 7 & 8: no look-ahead before pivot confirmedAtIndex and replay/as-of never repaints finalized items", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 28, 20, 27],
    [27, 28, 24, 26],
    [26, 24, 13, 13.5],
    [13.5, 15, 12, 14],
  ]);

  const seenFinalized = new Map();
  const seenEvents = [];
  for (let closed = 1; closed <= bars.length; closed++) {
    const snap = analyzeMarketStructure(bars, { left: 1, right: 1 }, closed);
    for (const swing of snap.swings) {
      assert.ok(swing.confirmedAtIndex < closed);
      if (swing.status === "finalized") {
        assert.ok(swing.structuralFinalizedAtIndex !== null && swing.structuralFinalizedAtIndex < closed);
        const key = `${swing.pivotIndex}|${swing.kind}`;
        if (seenFinalized.has(key)) {
          assert.deepEqual(swing, seenFinalized.get(key));
        } else {
          seenFinalized.set(key, swing);
        }
      }
    }
    for (const ev of snap.breakEvents) {
      assert.ok(ev.pivotConfirmedAtIndex < ev.breakIndex);
      assert.ok(ev.breakIndex < closed);
    }
    for (let i = 0; i < seenEvents.length; i++) {
      assert.deepEqual(snap.breakEvents[i], seenEvents[i]);
    }
    while (seenEvents.length < snap.breakEvents.length) {
      seenEvents.push(snap.breakEvents[seenEvents.length]);
    }
  }
});

test("Scenario 9: same-bar dual pivot (outside bar) is documented as ambiguous without fake intra-bar order", () => {
  // Bar 3 is both highest high (30) and lowest low (2) in [2..4].
  const bars = makeSimpleBars([
    [10, 8], [15, 9], [12, 8], [30, 2], [14, 7], [16, 8], [12, 6],
  ]);
  const raw = detectSwings(bars, 1, 1);
  assert.ok(raw.some((p) => p.index === 3 && p.kind === "high"));
  assert.ok(raw.some((p) => p.index === 3 && p.kind === "low"));

  const res = analyzeMarketStructure(bars, { left: 1, right: 1 });
  assert.equal(res.ambiguousDualPivots.length, 1);
  assert.deepEqual(res.ambiguousDualPivots[0], {
    index: 3,
    confirmedAtIndex: 4,
    highPrice: 30,
    lowPrice: 2,
    resolution: "excluded-ambiguous",
  });
  // No two structural swings share the same bar index or repeat the same kind.
  for (let i = 1; i < res.swings.length; i++) {
    assert.notEqual(res.swings[i].pivotIndex, res.swings[i - 1].pivotIndex);
    assert.notEqual(res.swings[i].kind, res.swings[i - 1].kind);
  }
  assert.ok(!res.swings.some((s) => s.pivotIndex === 3));
});

test("Scenario 10: incremental append/tail matches full scan and offscreen structural pivots govern visible trend", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 28, 20, 27],
    [27, 28, 24, 26],
    [26, 27, 23, 25],
    [25, 26, 22, 24],
    [24, 25, 21, 23],
  ]);

  const inc = new IncrementalMarketStructure();
  const stream = [];
  for (const bar of bars) {
    stream.push({ ...bar });
    // Live open-bar tick simulation: closedLength = stream.length - 1
    const closed = Math.max(0, stream.length - 1);
    const beforeWindows = inc.evaluatedWindows;
    const liveTickSnap = inc.update(stream, { left: 1, right: 1 }, "tail", closed);
    assert.equal(inc.evaluatedWindows, beforeWindows, "live open-bar tick outside closedLength evaluates 0 windows");
    assert.deepEqual(liveTickSnap.swings, analyzeMarketStructure(stream, { left: 1, right: 1 }, closed).swings);

    const incFull = inc.update(stream, { left: 1, right: 1 }, "append", stream.length);
    const oracle = analyzeMarketStructure(stream, { left: 1, right: 1 }, stream.length);
    assert.deepEqual(incFull.swings, oracle.swings);
    assert.deepEqual(incFull.breakEvents, oracle.breakEvents);
    assert.deepEqual(incFull.protectedLevels, oracle.protectedLevels);
    assert.equal(incFull.trend, oracle.trend);
  }

  // Offscreen structural pivots still establish trend and active protectedLow when range starts at bar 9.
  const ctx = context(bars);
  ctx.range = [9, bars.length];
  const prepared = definition.prepareData(ctx);
  assert.equal(prepared.meta.trend, "bullish");
  assert.equal(prepared.meta.activeProtectedLow?.price, 15);
  assert.ok(prepared.meta.protectedLevels.some((l) => l.status === "active" && l.price === 15));
  assert.ok(prepared.meta.breakEvents.some((e) => e.kind === "BOS" && e.breakIndex === 9));
});

test("history correction (replaceRange) resets cleanly and matches fresh series", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 28, 20, 27],
    [27, 28, 24, 26],
  ]);
  const ctx = context(bars);
  definition.prepareData(ctx);

  // Mutate an earlier historical bar (index 5) via replaceRange -> nonTailRevision bumps.
  const corrected = structuredClone(bars);
  corrected[5] = { ...corrected[5], high: 30, close: 28 };
  ctx.series.replaceRange(corrected.slice(4, 7));
  const afterCorrection = definition.prepareData(ctx);

  const freshCtx = context(corrected);
  const oracle = definition.prepareData(freshCtx);
  assert.deepEqual(afterCorrection.points, oracle.points);
  assert.deepEqual(afterCorrection.meta.breakEvents, oracle.meta.breakEvents);
  assert.equal(afterCorrection.meta.trend, oracle.meta.trend);
});

test("pivotMode raw/structural/both, legacy settings fallback, and drawSwingMap rendering", () => {
  const bars = makeOhlcBars([
    [11, 12, 10, 11],
    [15, 20, 14, 19],
    [18, 16, 13, 14],
    [14, 15, 10, 12],
    [12, 18, 12, 17],
    [17, 25, 16, 23],
    [23, 22, 18, 19],
    [19, 20, 15, 18],
    [18, 21, 16, 20],
    [20, 28, 20, 27],
    [27, 28, 24, 26],
  ]);

  // Legacy settings object without any new keys must work without error.
  const legacyCtx = context(bars);
  legacyCtx.settings = {
    left: 1,
    right: 1,
    showLabels: true,
    showUnconfirmed: false,
    equalityToleranceSteps: 0,
    highColor: "#e06c75",
    lowColor: "#3fe0a0",
  };
  const legacyPrepared = definition.prepareData(legacyCtx);
  assert.equal(legacyPrepared.status, "ok");
  assert.ok(legacyPrepared.meta.breakEvents.some((e) => e.kind === "BOS"));

  // Both mode & wick mode rendering with full mock canvas.
  const richCtx = context(bars, { pivotMode: "both", breakConfirmation: "wick" });
  const richPrepared = definition.prepareData(richCtx);
  const canvas = makeRichCanvas();
  richCtx.view = { area: { left: 0, top: 0, width: 800, height: 400 }, colWidth: 10, xOfIndex: (i) => i * 10, yOfPrice: (p) => 400 - p };
  richCtx.ctx = canvas.ctx;
  definition.drawPriceOverlay(richCtx, richPrepared);
  assert.ok(canvas.lines.length >= 2, "draws protected level and BOS lines");
  assert.ok(canvas.texts.some((t) => t.text === "BOS (wick)"), "explicitly labels wick confirmation mode");
  assert.ok(canvas.texts.some((t) => t.text === "PL"), "labels active protected low");
  assert.equal(definition.getHeaderLabel({ settings: richCtx.settings }), "Swings 1/1 (wick)");

  // Raw mode preserves raw non-alternating pivots.
  const nonAltBars = makeSimpleBars([
    [10, 8], [12, 9], [10, 8], [16, 10], [11, 8], [10, 6], [12, 9],
  ]);
  const rawCtx = context(nonAltBars, { pivotMode: "raw" });
  const structCtx = context(nonAltBars, { pivotMode: "structural" });
  assert.equal(definition.prepareData(rawCtx).points.length, 3);
  assert.equal(definition.prepareData(structCtx).points.length, 2);
});

test("10k/50k bar performance and bounded incremental live-tick / pan / memory regression", () => {
  const N50K = 50_000;
  const makeWaveBars = (count) => Array.from({ length: count }, (_, i) => {
    const wave = Math.sin(i / 8) * 50 + Math.cos(i / 29) * 20;
    const mid = 10_000 + wave;
    return {
      startTime: i * 60_000,
      open: mid - 1,
      high: mid + 4,
      low: mid - 4,
      close: mid + (i % 2 === 0 ? 2 : -2),
      volume: 10,
      delta: 0,
      count: 4,
      cells: new Map(),
      hasRef: true,
    };
  });

  // 10k and 50k pure structural analysis + incremental append parity & memory bound
  const bars10k = makeWaveBars(10_000);
  const res10k = analyzeMarketStructure(bars10k, { left: 5, right: 5 });
  assert.ok(res10k.swings.length > 100);

  const bars50k = makeWaveBars(N50K);
  const inc50k = new IncrementalMarketStructure();
  const tStruct0 = performance.now();
  const initial50k = inc50k.update(bars50k, { left: 5, right: 5 }, "reset", N50K - 10);
  const structMs = performance.now() - tStruct0;
  assert.ok(initial50k.swings.length > 1000);
  assert.ok(structMs < 2000, `50k initial structure scan took ${structMs.toFixed(1)}ms`);

  const baseStructWindows = inc50k.evaluatedWindows;
  const heapBefore = process.memoryUsage().heapUsed;
  for (let k = N50K - 9; k <= N50K; k++) {
    inc50k.update(bars50k, { left: 5, right: 5 }, "append", k);
  }
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
  assert.ok(inc50k.evaluatedWindows - baseStructWindows <= 10, "incremental 50k appends bounded to 1 window/bar");
  assert.ok(heapDeltaMb < 64, `incremental 50k appends memory growth bounded (${heapDeltaMb.toFixed(1)} MB)`);

  // Indicator prepareData on FootprintSeries (49k + 20 appends stays under MAX_SERIES_BARS=50k)
  const N = 49_000;
  const largeBars = bars50k.slice(0, N);
  const series = new FootprintSeries({ intervalMs: 60_000, priceStep: 1 });
  series.loadBars(largeBars);
  const instance = createIndicatorInstance("swing-map", 0);
  instance.settings = { ...instance.settings, left: 5, right: 5 };
  const ctx = { ctx: {}, view: {}, rect: { top: 0, height: 300 }, range: [N - 300, N], series, instance, settings: instance.settings, requestRefresh() {} };

  const t0 = performance.now();
  const initial = definition.prepareData(ctx);
  const initialMs = performance.now() - t0;
  assert.equal(initial.status, "ok");
  assert.ok(initialMs < 2000, `49k initial prepareData took ${initialMs.toFixed(1)}ms`);

  const baseWindows = initial.meta.evaluatedWindows;
  const tLive0 = performance.now();
  for (let tick = 0; tick < 50; tick++) {
    ctx.series.addTrades([{ time: (N - 1) * 60_000 + tick + 1, price: 10_005 + tick * 0.1, qty: 1, isBuy: true, id: `perf-live-${tick}` }]);
    const afterTick = definition.prepareData(ctx);
    assert.equal(afterTick.meta.evaluatedWindows, baseWindows);
  }
  const liveMs = performance.now() - tLive0;
  assert.ok(liveMs < 200, `50 live ticks on 49k bars took ${liveMs.toFixed(1)}ms`);

  // Append 20 closed bars: each closed bar evaluates at most 1 new window.
  const tAppend0 = performance.now();
  for (let b = 0; b < 20; b++) {
    const idx = N + b;
    const mid = 10_000 + Math.sin(idx / 8) * 50;
    ctx.series.addTrades([
      { time: idx * 60_000 + 100, price: mid + 3, qty: 1, isBuy: true, id: `perf-app-a-${b}` },
      { time: idx * 60_000 + 200, price: mid - 3, qty: 1, isBuy: false, id: `perf-app-b-${b}` },
    ]);
    ctx.range = [idx - 299, idx + 1];
    definition.prepareData(ctx);
  }
  const appendMs = performance.now() - tAppend0;
  const afterAppend = definition.prepareData(ctx);
  assert.ok(afterAppend.meta.evaluatedWindows - baseWindows <= 20, "bounded windows on 20 closed appends");
  assert.ok(appendMs < 300, `20 closed appends on 49k bars took ${appendMs.toFixed(1)}ms`);
});
