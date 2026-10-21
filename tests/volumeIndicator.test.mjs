import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

async function volumeModule() {
  return import("../dist/features/indicators/builtins/volume.js");
}

function makeHudContext() {
  const texts = [];
  return {
    canvas: { width: 800, height: 500 },
    font: "",
    textAlign: "left",
    textBaseline: "top",
    fillStyle: "",
    texts,
    clearRect() {},
    fillText(text) {
      texts.push(String(text));
    },
    measureText(text) {
      return { width: String(text).length * 7 };
    },
  };
}

test("volume bars use buy/sell colors from delta sign", async () => {
  const { volumeBarColor } = await volumeModule();
  assert.equal(volumeBarColor(12, "buy", "sell"), "buy");
  assert.equal(volumeBarColor(0, "buy", "sell"), "buy");
  assert.equal(volumeBarColor(-1, "buy", "sell"), "sell");
});

test("quote volume uses footprint price bins and falls back to close notional", async () => {
  const { quoteVolumeForBar } = await volumeModule();
  const bar = { close: 105, volume: 3, cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 2 }]]) };
  assert.equal(quoteVolumeForBar(bar), 300);
  assert.equal(quoteVolumeForBar({ ...bar, cells: new Map() }), 315);
});

test("quote volume completes partial footprint cells with close notional for remaining volume", async () => {
  const { quoteVolumeForBar } = await volumeModule();
  const partialBar = {
    close: 105,
    volume: 5,
    cells: new Map([[100, { priceBin: 100, buyVol: 1, sellVol: 2 }]]),
  };
  assert.equal(quoteVolumeForBar(partialBar), 510);
});

test("quote volume falls back to close notional when cells contain only liquidations", async () => {
  const { quoteVolumeForBar } = await volumeModule();
  const liquidationOnlyBar = {
    close: 105,
    volume: 3,
    cells: new Map([[100, { priceBin: 100, buyVol: 0, sellVol: 0, liquidationBuyVol: 4 }]]),
  };
  assert.equal(quoteVolumeForBar(liquidationOnlyBar), 315);
});

test("HUD notional volume and Volume indicator quoteVolume stay consistent across full, partial, and liquidation-only bars", async () => {
  const { quoteVolumeForBar, volumeIndicatorDefinition } = await volumeModule();
  const { Overlay } = await import("../dist/core/render/overlay.js");
  const { View } = await import("../dist/core/engine/view.js");

  const bars = [
    {
      startTime: 60_000,
      open: 100,
      high: 110,
      low: 100,
      close: 105,
      volume: 150,
      delta: 30,
      count: 10,
      cells: new Map([[103.2, { priceBin: 103.2, buyVol: 90, sellVol: 60 }]]),
      hasRef: true,
    },
    {
      startTime: 120_000,
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 150,
      delta: 20,
      count: 12,
      cells: new Map([[100, { priceBin: 100, buyVol: 60, sellVol: 40 }]]),
      hasRef: true,
    },
    {
      startTime: 180_000,
      open: 100,
      high: 110,
      low: 100,
      close: 105,
      volume: 100,
      delta: 10,
      count: 8,
      cells: new Map([[100, { priceBin: 100, buyVol: 0, sellVol: 0, liquidationBuyVol: 5 }]]),
      hasRef: true,
    },
  ];

  const series = {
    length: bars.length,
    config: { intervalMs: 60_000, priceStep: 0.1, pricePrecision: 1 },
    list: () => [...bars],
    listReadonly: () => bars,
    at: (index) => bars[index],
  };

  const prepared = volumeIndicatorDefinition.prepareData({
    range: [0, bars.length],
    series,
    instance: { visible: true },
    settings: volumeIndicatorDefinition.defaultSettings(),
    chart: { market: "BINANCE_FUTURES:btcusdt" },
  });

  const quoteSeries = prepared.meta.readoutSeries.find((item) => item.key === "quoteVolume");
  assert.ok(quoteSeries, "expected quoteVolume readout series");
  assert.deepEqual(
    quoteSeries.points.map((point) => point.value),
    [15_480, 15_500, 10_500],
  );
  assert.deepEqual(
    quoteSeries.points.map((point) => prepared.meta.formatter(point.value)),
    ["15.5K", "15.5K", "10.5K"],
  );

  const view = new View();
  view.area = { left: 0, top: 0, width: 800, height: 500 };
  const expectedHudVol = ["Vol $15.5k", "Vol $15.5k", "Vol $10.5k"];

  for (let i = 0; i < bars.length; i++) {
    assert.equal(quoteVolumeForBar(bars[i]), quoteSeries.points[i].value);
    let hudText = null;
    const ctx = makeHudContext();
    const overlay = new Overlay(
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (text) => {
        hudText = text;
      },
    );
    overlay.renderInteraction(view, series, { x: 0, y: 0, visible: false }, [0, i + 1], ["hud"]);
    assert.ok(hudText?.includes(expectedHudVol[i]), `bar ${i} HUD should include ${expectedHudVol[i]}, got: ${hudText}`);
  }
});

test("volume defaults use canonical theme colors", async () => {
  const { volumeIndicatorDefinition } = await volumeModule();
  const settings = volumeIndicatorDefinition.defaultSettings();
  assert.equal(settings.upColor, "#3fe0a0");
  assert.equal(settings.downColor, "#e06c75");
  assert.equal(settings.deltaColored, true);
});
