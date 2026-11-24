import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state = (value) => value;

const { findPointByIndex, findLastPointWithData } = await import(
  "../dist/features/indicators/builtins/pointLookup.js"
);
const { crossExchangeOpenInterestIndicatorDefinition } = await import(
  "../dist/features/indicators/builtins/crossExchangeOpenInterest.js"
);
const { fundingRegimeIndicatorDefinition } = await import(
  "../dist/features/indicators/builtins/fundingRegime.js"
);
const { futuresPositioningIndicatorDefinition } = await import(
  "../dist/features/indicators/builtins/futuresPositioning.js"
);
const { liquidationsIndicatorDefinition } = await import(
  "../dist/features/indicators/builtins/liquidations.js"
);
const { indicatorReadoutToText } = await import(
  "../dist/features/indicators/render/indicatorPaneUi.js"
);

function createCanvasMock() {
  const fillTexts = [];
  const verticalLines = [];
  let dash = [];
  let currentPath = [];

  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    save() {},
    restore() {},
    setLineDash(next) {
      dash = [...next];
    },
    beginPath() {
      currentPath = [];
    },
    moveTo(x, y) {
      currentPath.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      currentPath.push({ op: "lineTo", x, y });
    },
    stroke() {
      if (
        dash.length === 2
        && dash[0] === 3
        && dash[1] === 3
        && currentPath.length >= 2
        && currentPath[0].op === "moveTo"
        && currentPath[1].op === "lineTo"
        && currentPath[0].x === currentPath[1].x
      ) {
        verticalLines.push(currentPath[0].x);
      }
    },
    fillRect() {},
    strokeRect() {},
    roundRect() {},
    fill() {},
    measureText(text) {
      return { width: String(text).length * 6 };
    },
    fillText(text, x, y) {
      fillTexts.push({ text: String(text), x, y });
    },
  };

  return { ctx, fillTexts, verticalLines };
}

function createDrawContext(canvas, settings, crosshair) {
  return {
    ctx: canvas,
    rect: { top: 0, height: 140 },
    view: {
      area: { left: 0, width: 1200 },
      colWidth: 10,
      priceAxisW: 60,
      indexOfX: (x) => x / 10,
      xOfIndex: (index) => index * 10,
    },
    series: {
      config: { intervalMs: 60_000 },
    },
    chart: { intervalMs: 60_000, timeframe: "1m" },
    settings,
    crosshair,
  };
}

function withIndexCounter(points, counter) {
  return points.map((pt) => {
    const idx = pt.index;
    const copy = { ...pt };
    Object.defineProperty(copy, "index", {
      enumerable: true,
      get() {
        counter.reads += 1;
        return idx;
      },
    });
    return copy;
  });
}

function buildSparsePoints(kind, count = 500) {
  const points = [];
  const baseTime = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    const index = i * 2; // sparse: even indices exist, odd indices are gaps
    const candleStart = baseTime + index * 60_000;
    const hasData = i < count - 3; // last 3 points have hasData: false
    if (kind === "oi") {
      points.push({
        index,
        candleStart,
        value: 1000 + i * 10,
        openInterestUsd: 1000 + i * 10,
        openInterestDeltaUsd: i % 2 === 0 ? 50 : -25,
        hasData,
      });
    } else if (kind === "funding") {
      points.push({
        index,
        candleStart,
        value: 0.0001 * ((i % 7) - 3),
        fundingRate: 0.0001 * ((i % 7) - 3),
        predictedFundingRate: 0.00012,
        spread: 0.00002,
        hasData,
      });
    } else if (kind === "positioning") {
      points.push({
        index,
        candleStart,
        value: 1000 + i * 5,
        openInterestUsd: 1000 + i * 5,
        openInterestDeltaUsd: 15,
        globalLongShortRatio: 1.25,
        topTraderPositionLongShortRatio: 1.4,
        takerLongShortVolumeRatio: 0.95,
        hasData,
      });
    } else {
      points.push({
        index,
        candleStart,
        longLiquidationsUsd: 200 + i,
        shortLiquidationsUsd: 150 + i,
        liquidationDeltaUsd: -50,
        hasData,
      });
    }
  }
  return points;
}

const INDICATOR_SPECS = [
  {
    name: "crossExchangeOpenInterest",
    def: crossExchangeOpenInterestIndicatorDefinition,
    kind: "oi",
    meta: { mode: "openInterestUsd", interval: "1m", symbolCount: 2, truncated: false },
    range: { min: 0, max: 10_000, baseline: 0 },
  },
  {
    name: "fundingRegime",
    def: fundingRegimeIndicatorDefinition,
    kind: "funding",
    meta: { mode: "fundingRate", interval: "1m", symbolCount: 2 },
    range: { min: -0.001, max: 0.001, baseline: 0 },
  },
  {
    name: "futuresPositioning",
    def: futuresPositioningIndicatorDefinition,
    kind: "positioning",
    meta: { mode: "openInterestUsd", interval: "1m", symbolCount: 1 },
    range: { min: 0, max: 10_000, baseline: 0 },
  },
  {
    name: "liquidations",
    def: liquidationsIndicatorDefinition,
    kind: "liquidations",
    meta: { maxAbs: 1000 },
    range: { min: -1000, max: 1000, baseline: 0 },
  },
];

test("pointLookup helpers handle sorted, sparse, empty, and no-hasData arrays", () => {
  const pts = [
    { index: 2, hasData: false },
    { index: 5, hasData: true },
    { index: 10, hasData: false },
  ];
  assert.equal(findPointByIndex(pts, 2), pts[0]);
  assert.equal(findPointByIndex(pts, 5), pts[1]);
  assert.equal(findPointByIndex(pts, 10), pts[2]);
  assert.equal(findPointByIndex(pts, 7), null);
  assert.equal(findPointByIndex([], 0), null);

  assert.equal(findLastPointWithData(pts), pts[1]);
  assert.equal(findLastPointWithData([{ index: 1, hasData: false }, { index: 3, hasData: false }]).index, 3);
  assert.equal(findLastPointWithData([]), null);
});

for (const spec of INDICATOR_SPECS) {
  test(`${spec.name}: 60 drawInteraction calls stay O(60 * log2(500)) for showReadout true and false`, () => {
    for (const showReadout of [true, false]) {
      const counter = { reads: 0 };
      const points = withIndexCounter(buildSparsePoints(spec.kind, 500), counter);
      const prepared = { status: "ok", meta: spec.meta, range: spec.range, points };
      const settings = { ...spec.def.defaultSettings(), showReadout };
      const { ctx: canvas } = createCanvasMock();

      for (let step = 0; step < 60; step++) {
        // Mix hit indices (beginning, middle, end) and sparse gaps
        const targetIndex = step % 5 === 0 ? step * 15 + 1 : step * 16;
        const drawCtx = createDrawContext(canvas, settings, {
          visible: true,
          x: targetIndex * 10 + 5,
          y: 60,
        });
        spec.def.drawInteraction(drawCtx, prepared);
      }

      // 60 * (ceil(log2(500)) + 2) = 60 * 11 = 660; allow small margin <= 840
      assert.ok(
        counter.reads <= 840,
        `${spec.name} (showReadout=${showReadout}) read .index ${counter.reads} times (expected <= 840)`,
      );
    }
  });

  test(`${spec.name}: preserves readout & vertical guide across start/mid/end/gap/hidden/empty`, () => {
    const rawPoints = buildSparsePoints(spec.kind, 500);
    const prepared = { status: "ok", meta: spec.meta, range: spec.range, points: rawPoints };
    const settings = { ...spec.def.defaultSettings(), showReadout: true };

    const cases = [
      { label: "start", crosshair: { visible: true, x: 5, y: 60 }, expectedIndex: 0, expectGuide: true },
      { label: "middle", crosshair: { visible: true, x: 500 * 10 + 5, y: 60 }, expectedIndex: 500, expectGuide: true },
      { label: "end", crosshair: { visible: true, x: 998 * 10 + 5, y: 60 }, expectedIndex: 998, expectGuide: true },
      { label: "sparse-gap", crosshair: { visible: true, x: 501 * 10 + 5, y: 60 }, expectedIndex: null, expectGuide: false },
      { label: "crosshair-hidden", crosshair: { visible: false, x: 500 * 10 + 5, y: 60 }, expectedIndex: null, expectGuide: false },
    ];

    for (const c of cases) {
      const mock = createCanvasMock();
      const drawCtx = createDrawContext(mock.ctx, settings, c.crosshair);
      spec.def.drawInteraction(drawCtx, prepared);

      const expectedReadout = spec.def.getReadout(drawCtx, prepared, c.expectedIndex);
      assert.ok(expectedReadout, `${spec.name} (${c.label}) expected readout`);
      const expectedText = indicatorReadoutToText(expectedReadout);

      if (c.expectedIndex === null) {
        assert.equal(expectedReadout.title, "Last", `${spec.name} (${c.label}) should use Last title`);
      }

      assert.ok(
        mock.fillTexts.some((entry) => entry.text === expectedText),
        `${spec.name} (${c.label}) missing readout text "${expectedText}"`,
      );

      if (c.expectGuide) {
        const expectedX = c.expectedIndex * 10 + 5;
        assert.deepEqual(mock.verticalLines, [expectedX], `${spec.name} (${c.label}) vertical guide mismatch`);
      } else {
        assert.deepEqual(mock.verticalLines, [], `${spec.name} (${c.label}) should not draw vertical guide`);
      }
    }

    // Empty panel case
    const emptyPrepared = { status: "ok", meta: spec.meta, range: spec.range, points: [] };
    const emptyMock = createCanvasMock();
    const emptyCtx = createDrawContext(emptyMock.ctx, settings, { visible: true, x: 100, y: 60 });
    spec.def.drawInteraction(emptyCtx, emptyPrepared);
    assert.deepEqual(emptyMock.verticalLines, []);
    assert.equal(spec.def.getReadout(emptyCtx, emptyPrepared, null), null);
  });
}
