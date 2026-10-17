import test from "node:test";
import assert from "node:assert/strict";
import { optionsGexWallIndicatorDefinition } from "../dist/features/indicators/builtins/optionsGexWall.js";

function surface(withZones = true) {
  const value = {
    spotPrice: 60_000,
    strikeNetGexCrossing: 60_500,
    maxPain: 60_000,
    callWall: 64_000,
    putWall: 58_000,
  };
  if (!withZones) return value;
  return {
    ...value,
    strikeNetGexCrossingZone: { priceLow: 60_000, priceHigh: 61_000, confidence: 0.5 },
    callWallZone: { priceLow: 63_000, priceHigh: 64_500, confidence: 0.72 },
    putWallZone: { priceLow: 57_500, priceHigh: 58_500, confidence: 0.64 },
  };
}

function canvasRecorder() {
  const fills = [];
  const texts = [];
  const state = [];
  const canvas = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    save() { state.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle }); },
    restore() { Object.assign(this, state.pop() ?? { globalAlpha: 1 }); },
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillText(text, x, y) { texts.push({ text: String(text), x, y }); },
    measureText(text) { return { width: String(text).length * 6 }; },
    fillRect(x, y, width, height) { fills.push({ x, y, width, height, alpha: this.globalAlpha, color: this.fillStyle }); },
  };
  return { canvas, fills, texts };
}

function draw(withZones, showZones = true, showPlotLabel = true) {
  const { canvas, fills, texts } = canvasRecorder();
  const labels = [];
  const settings = {
    ...optionsGexWallIndicatorDefinition.defaultSettings(),
    showZones,
    showPlotLabel,
    showStrikeBars: false,
  };
  const ctx = {
    ctx: canvas,
    settings,
    instance: { visible: true },
    view: {
      area: { left: 10, top: 20, width: 500, height: 240 },
      yOfPrice: (price) => 20 + (70_000 - price) / 20_000 * 240,
    },
    queuePriceLabel: (price, text, color, priority) => labels.push({ price, text, color, priority }),
  };
  const prepared = { status: "ok", points: [], meta: { base: "BTC", surface: surface(withZones) } };
  optionsGexWallIndicatorDefinition.drawPriceOverlay(ctx, prepared);
  return { fills, labels, texts };
}

test("Options GEX wall draws low-alpha structural zones and confidence labels", () => {
  const { fills, labels } = draw(true, true);
  const zoneFills = fills.filter((fill) => fill.width === 500 && fill.alpha === 0.12);
  assert.equal(zoneFills.length, 3);
  assert.equal(labels.some((label) => label.text.includes("net GEX cross 50%")), true);
  assert.equal(labels.some((label) => label.text.includes("call wall 72%")), true);
  assert.equal(labels.some((label) => label.text.includes("put wall 64%")), true);

  const baseField = optionsGexWallIndicatorDefinition.settingsSchema.sections[0].fields.find((field) => field.key === "base");
  assert.deepEqual(baseField.options.map((option) => option.value), ["auto", "BTC", "ETH", "SOL", "HYPE", "XRP"]);

  const settings = optionsGexWallIndicatorDefinition.defaultSettings();
  assert.match(optionsGexWallIndicatorDefinition.getHeaderLabel({ settings, chart: { market: "BINANCE:SOLUSDT" } }), /· SOL ·/);
  assert.match(optionsGexWallIndicatorDefinition.getHeaderLabel({ settings, chart: { market: "DERIBIT:HYPE_USDC-PERPETUAL" } }), /· HYPE ·/);
  assert.match(optionsGexWallIndicatorDefinition.getHeaderLabel({ settings, chart: { market: "BYBIT:XRPUSDT" } }), /· XRP ·/);
});

test("Options GEX wall keeps scalar levels for legacy surfaces and honors showZones", () => {
  const disabled = draw(true, false);
  assert.equal(disabled.fills.some((fill) => fill.width === 500 && fill.alpha === 0.12), false);
  assert.equal(disabled.labels.length, 4);

  const legacy = draw(false, true);
  assert.equal(legacy.fills.some((fill) => fill.width === 500 && fill.alpha === 0.12), false);
  assert.equal(legacy.labels.length, 4);
  assert.equal(legacy.labels.every((label) => !label.text.includes("%")), true);
});


test("Options GEX showPlotLabel hides in-chart tags without hiding levels or queued price labels", () => {
  const visible = draw(true, true, true);
  const hidden = draw(true, true, false);

  assert.ok(visible.texts.length > 0);
  assert.equal(hidden.texts.length, 0);
  assert.equal(hidden.labels.length, 4);
  assert.equal(hidden.fills.filter((fill) => fill.width === 500 && fill.alpha === 0.12).length, 3);
});
