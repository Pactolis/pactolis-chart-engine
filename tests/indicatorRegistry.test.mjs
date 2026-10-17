import test from "node:test";
import assert from "node:assert/strict";

// Indicator built-ins read small Svelte stores through tz formatting helpers.
// Unit tests run outside the Svelte compiler/runtime, so provide the minimal
// rune shim used by other plain Node tests when importing compiled modules.
globalThis.$state ??= (value) => value;

const heavyTypes = [
  "cross-exchange-open-interest",
  "funding-regime",
  "futures-positioning",
  "liquidations",
  "options-gex-wall",
];

async function registry() {
  const module = await import("../dist/features/indicators/registry.js");
  await module.preloadIndicatorDefinitions(heavyTypes);
  return module;
}

test("indicator catalog exposes heavyweight entries without requiring definitions", async () => {
  const module = await import("../dist/features/indicators/registry.js");
  const catalog = module.listIndicatorDefinitions();
  for (const type of heavyTypes) assert.ok(catalog.some((entry) => entry.type === type));
});

test("indicator catalog keeps all 24 addable types with settings and serializable defaults", async () => {
  const module = await registry();
  const catalog = module.listIndicatorDefinitions();
  assert.equal(catalog.length, 24);
  assert.equal(new Set(catalog.map((entry) => entry.type)).size, 24);

  for (const [order, entry] of catalog.entries()) {
    const definition = module.getIndicatorDefinition(entry.type);
    assert.ok(definition, `${entry.type} definition must load`);
    assert.ok(Array.isArray(definition.settingsSchema.sections), `${entry.type} settings schema must be available`);
    const instance = module.createIndicatorInstance(entry.type, order);
    assert.equal(instance.type, entry.type);
    assert.equal(instance.order, order);
    assert.doesNotThrow(() => JSON.stringify(instance.settings), `${entry.type} defaults must persist as JSON`);
  }
});

test("new indicator instances persist layout and placement defaults", async () => {
  const { createIndicatorInstance } = await registry();
  const instance = createIndicatorInstance("cvd", 2);
  assert.equal(instance.type, "cvd");
  assert.equal(instance.order, 2);
  assert.equal(instance.paneHeight, 116);
  assert.equal(instance.collapsed, false);
  assert.equal(instance.placement, "separate-pane");
});

test("built-in separate-pane indicators do not advertise unsupported overlays", async () => {
  const {
    defaultIndicatorPlacement,
    getIndicatorDefinition,
    isIndicatorPlacementSupported,
    supportedIndicatorPlacements,
  } = await registry();
  const cvd = getIndicatorDefinition("cvd");
  const crossOi = getIndicatorDefinition("cross-exchange-open-interest");
  const funding = getIndicatorDefinition("funding-regime");
  const positioning = getIndicatorDefinition("futures-positioning");
  const liquidations = getIndicatorDefinition("liquidations");
  assert.ok(cvd);
  assert.ok(crossOi);
  assert.ok(funding);
  assert.ok(positioning);
  assert.ok(liquidations);
  assert.equal(defaultIndicatorPlacement(cvd), "separate-pane");
  assert.equal(defaultIndicatorPlacement(crossOi), "separate-pane");
  assert.equal(defaultIndicatorPlacement(funding), "separate-pane");
  assert.equal(defaultIndicatorPlacement(positioning), "separate-pane");
  assert.deepEqual(supportedIndicatorPlacements(cvd), ["separate-pane"]);
  assert.deepEqual(supportedIndicatorPlacements(crossOi), ["separate-pane"]);
  assert.deepEqual(supportedIndicatorPlacements(funding), ["separate-pane"]);
  assert.deepEqual(supportedIndicatorPlacements(positioning), ["separate-pane"]);
  assert.equal(isIndicatorPlacementSupported(cvd, "price-overlay"), false);
  assert.equal(isIndicatorPlacementSupported(crossOi, "price-overlay"), false);
  assert.equal(isIndicatorPlacementSupported(funding, "price-overlay"), false);
  assert.equal(isIndicatorPlacementSupported(positioning, "price-overlay"), false);
  assert.equal(isIndicatorPlacementSupported(liquidations, "overlay-scale"), false);
});

test("Order Flow Profile only supports price-overlay placement", async () => {
  const {
    defaultIndicatorPlacement,
    getIndicatorDefinition,
    isIndicatorPlacementSupported,
    supportedIndicatorPlacements,
  } = await registry();
  const profile = getIndicatorDefinition("volume-profile");
  assert.ok(profile);
  assert.equal(defaultIndicatorPlacement(profile), "price-overlay");
  assert.deepEqual(supportedIndicatorPlacements(profile), ["price-overlay"]);
  assert.equal(isIndicatorPlacementSupported(profile, "separate-pane"), false);
});

test("Options GEX wall is a removable price-overlay indicator by default", async () => {
  const {
    createIndicatorInstance,
    defaultIndicatorPlacement,
    getIndicatorDefinition,
    supportedIndicatorPlacements,
  } = await registry();
  const gexWall = getIndicatorDefinition("options-gex-wall");
  assert.ok(gexWall);
  assert.equal(defaultIndicatorPlacement(gexWall), "price-overlay");
  assert.deepEqual(supportedIndicatorPlacements(gexWall), ["price-overlay"]);

  const instance = createIndicatorInstance("options-gex-wall", 1);
  assert.equal(instance.placement, "price-overlay");
  assert.equal(instance.visible, true);
  assert.equal(instance.settings.showLevels, true);
  assert.equal(instance.settings.showZones, true);
  assert.equal(instance.settings.maxPainColor, "#f2c94c");
  assert.equal(Object.hasOwn(instance.settings, "mode"), false);
  assert.equal(gexWall.settingsSchema.sections.some((section) => section.fields.some((field) => field.key === "mode")), false);
  assert.equal(gexWall.settingsSchema.sections.some((section) => section.fields.some((field) => field.key === "showZones" && field.labelKey === "indicator.optionsGexWall.showZones")), true);
});

test("Bar Stats exposes renderer fontSize and CVD custom buckets are conditional", async () => {
  const { getIndicatorDefinition } = await registry();
  const barStats = getIndicatorDefinition("bar-stats");
  const cvd = getIndicatorDefinition("cvd");
  assert.ok(barStats);
  assert.ok(cvd);
  assert.equal(barStats.defaultSettings().fontSize, 12);
  const fontSize = barStats.settingsSchema.sections.flatMap((section) => section.fields).find((field) => field.key === "fontSize");
  assert.deepEqual({ kind: fontSize?.kind, min: fontSize?.min, max: fontSize?.max, step: fontSize?.step }, { kind: "number", min: 9, max: 18, step: 1 });
  const customBuckets = cvd.settingsSchema.sections.flatMap((section) => section.fields).find((field) => field.key === "customBuckets");
  assert.deepEqual(customBuckets?.visibleWhen, { key: "bucketMode", values: ["custom"] });
});

test("Options GEX exposes numeric expiry values and plot-label visibility", async () => {
  const { getIndicatorDefinition } = await registry();
  const gex = getIndicatorDefinition("options-gex-wall");
  assert.ok(gex);
  const fields = gex.settingsSchema.sections.flatMap((section) => section.fields);
  const expiry = fields.find((field) => field.key === "maxExpiryDays");
  assert.deepEqual(expiry?.options?.map((option) => option.value), [7, 30, 60, 90]);
  assert.equal(fields.some((field) => field.key === "showPlotLabel" && field.kind === "boolean"), true);
  const settings = gex.defaultSettings();
  assert.match(gex.getHeaderLabel({ settings, chart: { market: "BINANCE_FUTURES:btcusdt" } }), /Options GEX Wall/);
  assert.equal(gex.getHeaderLabel({ settings: { ...settings, showPlotLabel: false }, chart: { market: "BINANCE_FUTURES:btcusdt" } }), "");
});

test("CVD default settings expose only chart-delta settings", async () => {
  const { getIndicatorDefinition } = await registry();
  const cvd = getIndicatorDefinition("cvd");
  assert.ok(cvd);
  const settings = cvd.defaultSettings();
  assert.equal(Object.hasOwn(settings, "tradeSizeFilter"), false);
  assert.equal(Object.hasOwn(settings, "marketTypes"), false);
  assert.equal(Object.hasOwn(settings, "exchanges"), false);
  assert.equal(settings.showReadout, true);
  assert.equal(settings.showLastValueLabel, true);
});


test("built-in header labels include compact metadata", async () => {
  const { getIndicatorDefinition } = await registry();
  const cvd = getIndicatorDefinition("cvd");
  const crossOi = getIndicatorDefinition("cross-exchange-open-interest");
  const funding = getIndicatorDefinition("funding-regime");
  const positioning = getIndicatorDefinition("futures-positioning");
  const liquidations = getIndicatorDefinition("liquidations");
  assert.ok(cvd?.getHeaderLabel);
  assert.ok(crossOi?.getHeaderLabel);
  assert.ok(funding?.getHeaderLabel);
  assert.ok(positioning?.getHeaderLabel);
  assert.ok(liquidations?.getHeaderLabel);

  const cvdSettings = cvd.defaultSettings();
  const cvdLabel = cvd.getHeaderLabel({
    instance: { id: "i1", type: "cvd", title: "CVD", visible: true, paneId: "p1", order: 0, settings: cvdSettings },
    settings: cvdSettings,
    chart: { market: "BTCUSDT", timeframe: "1d", intervalMs: 86_400_000 },
  });
  assert.equal(cvdLabel, "CVD");

  const crossOiSettings = crossOi.defaultSettings();
  const crossOiLabel = crossOi.getHeaderLabel({
    instance: { id: "i4", type: "cross-exchange-open-interest", title: "Cross-Exchange OI", visible: true, paneId: "p4", order: 3, settings: crossOiSettings },
    settings: crossOiSettings,
    chart: { market: "BTCUSDT", timeframe: "1h", intervalMs: 3_600_000 },
    prepared: {
      status: "ok",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: "1hour", mode: "openInterestDeltaUsd", truncated: false, symbolCount: 18 },
    },
  });
  assert.equal(crossOiLabel, "Cross OI 1h | OI Delta | src 1hour | 9ex | USD+COIN | 18 sym");

  const fundingSettings = funding.defaultSettings();
  const fundingLabel = funding.getHeaderLabel({
    instance: { id: "i5", type: "funding-regime", title: "Funding Regime", visible: true, paneId: "p5", order: 4, settings: fundingSettings },
    settings: fundingSettings,
    chart: { market: "BTCUSDT", timeframe: "1h", intervalMs: 3_600_000 },
    prepared: {
      status: "ok",
      points: [],
      range: { min: -0.01, max: 0.01, baseline: 0 },
      meta: { interval: "1hour", mode: "fundingRate", truncated: true, symbolCount: 20 },
    },
  });
  assert.equal(fundingLabel, "Funding 1h | Funding | src 1hour | 9ex | USD+COIN | 20 sym | truncated");

  const positioningSettings = positioning.defaultSettings();
  const positioningLabel = positioning.getHeaderLabel({
    instance: { id: "i3", type: "futures-positioning", title: "Futures Positioning", visible: true, paneId: "p3", order: 2, settings: positioningSettings },
    settings: positioningSettings,
    chart: { market: "BINANCE_FUTURES:btcusdt", timeframe: "1d", intervalMs: 86_400_000 },
    prepared: {
      status: "ok",
      points: [],
      range: { min: 0, max: 1 },
      meta: { symbol: "BTCUSDT", interval: "5m", mode: "openInterestUsd", truncated: false, missingDays: 0 },
    },
  });
  assert.equal(positioningLabel, "Positioning 1d | OI Notional | src 5m | BTCUSDT");

  const liqSettings = liquidations.defaultSettings();
  const liqLabel = liquidations.getHeaderLabel({
    instance: { id: "i2", type: "liquidations", title: "Liquidations", visible: true, paneId: "p2", order: 1, settings: liqSettings },
    settings: liqSettings,
    chart: { market: "BTCUSDT", timeframe: "1d", intervalMs: 86_400_000 },
    prepared: {
      status: "ok",
      points: [],
      range: { min: -1, max: 1, baseline: 0 },
      meta: { interval: "1D", truncated: false, symbolCount: 20, maxAbs: 1 },
    },
  });
  assert.equal(liqLabel, "Liquidations 1d · src 1D · 9ex · USD+COIN · 20 sym");
});

// --- T02B qualifier slice1 (#310): instance/pane identity + independent defaults ---
test("T02B qualifier registry owns instance and pane identity with independent defaults", async () => {
  const { createIndicatorInstance, getIndicatorDefinition } = await registry();
  const definition = getIndicatorDefinition("moving-average");
  assert.ok(definition);

  const instanceA = createIndicatorInstance("moving-average", 3);
  const instanceB = createIndicatorInstance("moving-average", 4);

  assert.equal(typeof instanceA.id, "string");
  assert.ok(instanceA.id.length > 0);
  assert.equal(typeof instanceB.id, "string");
  assert.ok(instanceB.id.length > 0);
  assert.notEqual(instanceA.id, instanceB.id);
  assert.ok(instanceA.paneId.length > 0);
  assert.ok(instanceB.paneId.length > 0);
  assert.notEqual(instanceA.paneId, instanceB.paneId);

  assert.notEqual(instanceA.settings, instanceB.settings);
  assert.notEqual(instanceA.settings.lines, instanceB.settings.lines);
  assert.notEqual(instanceA.settings.lines[0], instanceB.settings.lines[0]);

  const periodBefore = instanceA.settings.lines[0].period;
  const colorBefore = instanceA.settings.lines[0].color;
  instanceA.settings.lines[0].period = 999;
  instanceA.settings.lines[0].color = "#t02b-qualifier-mutated";
  assert.equal(instanceA.settings.lines[0].period, 999);

  assert.equal(instanceB.settings.lines[0].period, periodBefore);
  assert.equal(instanceB.settings.lines[0].color, colorBefore);

  const freshDefaults = definition.defaultSettings();
  assert.equal(freshDefaults.lines[0].period, periodBefore);
  assert.equal(freshDefaults.lines[0].color, colorBefore);
  assert.notEqual(instanceA.settings.lines, freshDefaults.lines);
  assert.notEqual(instanceB.settings.lines, freshDefaults.lines);
  // Local default line IDs may coincide across owners; only identity objects must differ.
  assert.equal(instanceA.settings.lines[0].id, instanceB.settings.lines[0].id);
});

// --- TASK #328 (T10-B) CVD lifecycle pilot: static identity + clone-safe defaults ---
test("T10-B CVD pilot: static CVD registration identity is stable and defaults stay clone-safe", async () => {
  const { createIndicatorInstance, getIndicatorDefinition, listIndicatorDefinitions } = await registry();
  const cvdFirst = getIndicatorDefinition("cvd");
  const cvdSecond = getIndicatorDefinition("cvd");
  assert.ok(cvdFirst);
  assert.strictEqual(cvdSecond, cvdFirst, "static CVD registration must keep one stable definition object");
  assert.equal(cvdFirst.type, "cvd");
  assert.ok(listIndicatorDefinitions().some((entry) => entry.type === "cvd"));

  const defaultsBefore = structuredClone(cvdFirst.defaultSettings());
  const cvdInstance = createIndicatorInstance("cvd", 7);
  assert.equal(cvdInstance.order, 7);
  assert.equal(cvdInstance.placement, "separate-pane");
  cvdInstance.settings.lineWidth = 9;
  cvdInstance.settings.bucketMode = "custom";
  assert.equal(cvdInstance.settings.lineWidth, 9);
  const defaultsAfter = cvdFirst.defaultSettings();
  assert.equal(defaultsAfter.lineWidth, defaultsBefore.lineWidth, "mutating an instance setting must not leak into CVD defaults");
  assert.equal(defaultsAfter.bucketMode, defaultsBefore.bucketMode);
  assert.notStrictEqual(cvdInstance.settings, defaultsAfter);

  const movingAverage = getIndicatorDefinition("moving-average");
  assert.ok(movingAverage);
  const maInstance = createIndicatorInstance("moving-average", 8);
  assert.equal(maInstance.settings.lines.length, movingAverage.defaultSettings().lines.length);
  assert.notStrictEqual(maInstance.settings.lines, movingAverage.defaultSettings().lines, "unrelated registration keeps independent deep-cloned defaults");
  assert.notStrictEqual(maInstance.settings.lines[0], movingAverage.defaultSettings().lines[0], "unrelated registration keeps nested line objects decoupled from defaults");
});
// --- TASK #328 (T10-B) finding 3: full moving-average independence across CVD lifecycle actions ---
test("T10-B CVD pilot: CVD actions leave full moving-average settings, defaults and nested references untouched", async () => {
  const { createIndicatorInstance, getIndicatorDefinition } = await registry();
  const movingAverage = getIndicatorDefinition("moving-average");
  assert.ok(movingAverage);

  const maDefaultsSnapshot = structuredClone(movingAverage.defaultSettings());
  const maInstance = createIndicatorInstance("moving-average", 8);
  const maSettingsSnapshot = structuredClone(maInstance.settings);
  const maSecond = createIndicatorInstance("moving-average", 9);

  const cvd = getIndicatorDefinition("cvd");
  assert.ok(cvd);
  const cvdInstance = createIndicatorInstance("cvd", 7);
  cvdInstance.settings.lineWidth = 9;
  cvdInstance.settings.bucketMode = "custom";
  const cvdDefaults = cvd.defaultSettings();
  cvdDefaults.lineWidth = 42;
  cvdDefaults.bucketMode = "total";

  assert.deepEqual(maInstance.settings, maSettingsSnapshot, "full MA instance settings content is unchanged by CVD actions");
  assert.deepEqual(movingAverage.defaultSettings(), maDefaultsSnapshot, "full MA defaults content is unchanged by CVD actions");
  assert.equal(maDefaultsSnapshot.lineWidth, 1.5);
  assert.equal(maDefaultsSnapshot.showLastValueLabel, true);
  assert.equal(maDefaultsSnapshot.showPlotLabel, true);
  assert.equal(maDefaultsSnapshot.showChartLabels, false);
  assert.equal(maDefaultsSnapshot.lines.length, 3);
  assert.deepEqual(
    maDefaultsSnapshot.lines.map((line) => ({ id: line.id, method: line.method, period: line.period, timeframe: line.timeframe, enabled: line.enabled })),
    [
      { id: "line-20", method: "sma", period: 20, timeframe: "chart", enabled: true },
      { id: "line-50", method: "sma", period: 50, timeframe: "chart", enabled: true },
      { id: "line-200", method: "sma", period: 200, timeframe: "chart", enabled: true },
    ],
    "literal known MA default line identities (palette colors covered by full-content equality above)",
  );

  assert.notStrictEqual(maInstance.settings, maSecond.settings, "independent MA instances never share the settings object");
  assert.notStrictEqual(maInstance.settings.lines, maSecond.settings.lines, "independent MA instances never share the lines array");
  assert.notStrictEqual(maInstance.settings.lines[0], maSecond.settings.lines[0], "independent MA instances never share nested line objects");
  assert.notStrictEqual(maInstance.settings.lines, movingAverage.defaultSettings().lines, "MA instance settings stay decoupled from MA defaults");
  assert.notStrictEqual(cvdInstance.settings, maInstance.settings, "CVD and MA registrations never share settings objects");
  assert.notStrictEqual(cvdInstance.settings, movingAverage.defaultSettings(), "CVD instance settings stay decoupled from MA defaults");
});
