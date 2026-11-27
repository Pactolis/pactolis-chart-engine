import test from "node:test";
import assert from "node:assert/strict";

globalThis.$state ??= (value) => value;

async function loadModules() {
  const [
    bubbles,
    { FootprintSeries },
    { View },
    { IndicatorManager },
    { createIndicatorInstanceAsync },
    { configureIndicatorDataSource },
    { configureChartLocale },
    { createIndicatorPaneHeadersModel },
  ] = await Promise.all([
    import("../dist/features/indicators/builtins/liveTradeBubbles.js"),
    import("../dist/core/model/footprint.js"),
    import("../dist/core/engine/view.js"),
    import("../dist/features/indicators/IndicatorManager.js"),
    import("../dist/features/indicators/registry.js"),
    import("../dist/features/indicators/indicatorDataSource.js"),
    import("../dist/core/chartLocale.js"),
    import("../dist/features/indicators/indicatorPaneHeaders.js"),
  ]);

  configureChartLocale({
    locale: () => "en-US",
    timeZone: () => "UTC",
    translate: (key) => key,
    onLocaleChange: () => () => {},
  });

  return {
    bubbles,
    FootprintSeries,
    View,
    IndicatorManager,
    createIndicatorInstanceAsync,
    configureIndicatorDataSource,
    createIndicatorPaneHeadersModel,
  };
}

function makeBars(count, intervalMs = 60_000) {
  const baseTime = 1_699_999_980_000;
  return Array.from({ length: count }, (_, i) => ({
    startTime: baseTime + i * intervalMs,
    open: 50_000 + i * 10,
    high: 50_100 + i * 10,
    low: 49_900 + i * 10,
    close: 50_050 + i * 10,
    volume: 100,
    delta: 10,
    count: 20,
    cells: new Map(),
    hasRef: true,
  }));
}

function mockCanvasCtx() {
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    beginPath: noop,
    rect: noop,
    clip: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    roundRect: noop,
    fillText: noop,
    strokeText: noop,
    measureText: (txt) => ({ width: String(txt).length * 6 }),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "middle",
  };
}

test("eventXInBars maps event time proportionally inside its enclosing bar", async () => {
  const { bubbles } = await loadModules();
  const intervalMs = 60_000;
  const bars = makeBars(5, intervalMs);
  const xOfIndex = (idx) => 100 + idx * 20;

  assert.equal(bubbles.eventXInBars(bars[0].startTime - 1, bars, intervalMs, xOfIndex), null);
  assert.equal(bubbles.eventXInBars(bars[1].startTime, bars, intervalMs, xOfIndex), 120);
  assert.equal(bubbles.eventXInBars(bars[1].startTime + 30_000, bars, intervalMs, xOfIndex), 130);
  assert.equal(bubbles.eventXInBars(bars[4].startTime + 45_000, bars, intervalMs, xOfIndex), 195);
  assert.equal(bubbles.eventXInBars(bars[4].startTime + intervalMs * 2, bars, intervalMs, xOfIndex), null);
});

test("computeBubbleRadius enforces [3, 28] px bounds across relative and fixed scales", async () => {
  const { bubbles } = await loadModules();

  const tinyRel = bubbles.computeBubbleRadius(1, { scaleMode: "relative", sizeScale: 1, refMaxNotionalUsd: 1_000_000 });
  const maxRel = bubbles.computeBubbleRadius(1_000_000, { scaleMode: "relative", sizeScale: 1, refMaxNotionalUsd: 1_000_000 });
  const hugeRel = bubbles.computeBubbleRadius(10_000_000, { scaleMode: "relative", sizeScale: 2.5, refMaxNotionalUsd: 1_000_000 });

  assert.ok(tinyRel >= 3 && tinyRel <= 28);
  assert.equal(maxRel, 28);
  assert.equal(hugeRel, 28);

  const fixedSmall = bubbles.computeBubbleRadius(10_000, { scaleMode: "fixed", sizeScale: 1, refMaxNotionalUsd: 1 });
  const fixedLarge = bubbles.computeBubbleRadius(1_000_000, { scaleMode: "fixed", sizeScale: 1, refMaxNotionalUsd: 1 });
  assert.ok(fixedSmall > 3 && fixedSmall < fixedLarge);
  assert.equal(fixedLarge, 28);
});

test("clusterProjectedBubbles merges same-cell bubbles and conserves total notional", async () => {
  const { bubbles } = await loadModules();
  const input = [
    {
      x: 101,
      y: 201,
      event: { id: "1", kind: "trade", time: 1000, price: 60_000, qty: 1, notionalUsd: 60_000, side: "buy", venue: "binance" },
    },
    {
      x: 103,
      y: 202,
      event: { id: "2", kind: "trade", time: 1200, price: 60_010, qty: 2, notionalUsd: 120_000, side: "buy", venue: "bybit" },
    },
    {
      x: 102,
      y: 202,
      event: { id: "3", kind: "liquidation", time: 1300, price: 60_005, qty: 0.5, notionalUsd: 30_000, side: "long", venue: "binance", sampled: true },
    },
    {
      x: 150,
      y: 250,
      event: { id: "4", kind: "trade", time: 1400, price: 59_500, qty: 3, notionalUsd: 178_500, side: "sell", venue: "okx" },
    },
  ];

  const clustered = bubbles.clusterProjectedBubbles(input, 8);
  assert.equal(clustered.length, 3);
  const totalIn = input.reduce((s, item) => s + item.event.notionalUsd, 0);
  const totalOut = clustered.reduce((s, item) => s + item.notionalUsd, 0);
  assert.equal(totalOut, totalIn);

  const mergedBuy = clustered.find((c) => c.kind === "trade" && c.side === "buy");
  assert.ok(mergedBuy);
  assert.equal(mergedBuy.count, 2);
  assert.equal(mergedBuy.qty, 3);
  assert.equal(mergedBuy.notionalUsd, 180_000);

  const liq = clustered.find((c) => c.kind === "liquidation");
  assert.ok(liq);
  assert.equal(liq.sampled, true);
  const readout = bubbles.buildBubbleReadout({ ...liq, radius: 12, color: "#e6c84f" });
  assert.match(readout.title ?? "", /sampled/);
});

test("ring buffer caps stored events at 5,000 per market", async () => {
  const { bubbles } = await loadModules();
  bubbles.clearLiveTradeEvents();

  const batch = Array.from({ length: 5_250 }, (_, i) => ({
    id: `ev-${i}`,
    kind: "trade",
    time: 1_700_000_000_000 + i,
    price: 50_000,
    qty: 1,
    notionalUsd: 50_000,
    side: "buy",
    venue: "binance",
  }));
  bubbles.pushLiveTradeEvents("BTCUSDT", batch);

  const stored = bubbles.getLiveTradeEvents("BTCUSDT");
  assert.equal(stored.length, 5_000);
  assert.equal(stored[0].id, "ev-250");
  assert.equal(stored[4_999].id, "ev-5249");
  bubbles.clearLiveTradeEvents();
});

test("filterLiveTradeEvents respects kinds and notional thresholds", async () => {
  const { bubbles } = await loadModules();
  const events = [
    { id: "t1", kind: "trade", time: 1, price: 100, qty: 1, notionalUsd: 10_000, side: "buy", venue: "binance" },
    { id: "t2", kind: "trade", time: 2, price: 100, qty: 10, notionalUsd: 80_000, side: "sell", venue: "binance" },
    { id: "l1", kind: "liquidation", time: 3, price: 100, qty: 1, notionalUsd: 5_000, side: "long", venue: "binance", sampled: true },
    { id: "l2", kind: "liquidation", time: 4, price: 100, qty: 5, notionalUsd: 40_000, side: "short", venue: "bybit" },
  ];

  const both = bubbles.filterLiveTradeEvents(events, { kinds: "both", minTradeNotionalUsd: 50_000, minLiquidationNotionalUsd: 25_000 });
  assert.deepEqual(both.map((e) => e.id), ["t2", "l2"]);

  const tradesOnly = bubbles.filterLiveTradeEvents(events, { kinds: "trades", minTradeNotionalUsd: 0, minLiquidationNotionalUsd: 0 });
  assert.deepEqual(tradesOnly.map((e) => e.id), ["t1", "t2"]);

  const liqsOnly = bubbles.filterLiveTradeEvents(events, { kinds: "liquidations", minTradeNotionalUsd: 0, minLiquidationNotionalUsd: 0 });
  assert.deepEqual(liqsOnly.map((e) => e.id), ["l1", "l2"]);
});

test("subscription lifecycle unsubscribes on hide, remove, market-change, kinds-change, and dispose with zero leaks", async () => {
  const {
    bubbles,
    FootprintSeries,
    View,
    IndicatorManager,
    createIndicatorInstanceAsync,
    configureIndicatorDataSource,
    createIndicatorPaneHeadersModel,
  } = await loadModules();
  bubbles.clearLiveTradeEvents();

  const activeSubs = new Map();
  const subLog = [];
  let subSeq = 0;

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    subscribeLiveTradeEvents(input) {
      const token = ++subSeq;
      const rec = { token, market: input.market, kinds: [...input.kinds], scope: input.scope };
      activeSubs.set(token, rec);
      subLog.push({ op: "sub", ...rec });
      return () => {
        activeSubs.delete(token);
        subLog.push({ op: "unsub", ...rec });
      };
    },
  });

  const intervalMs = 60_000;
  const bars = makeBars(10, intervalMs);
  const series = new FootprintSeries({ intervalMs, priceStep: 10 });
  series.loadBars(bars);

  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.setVisibleIndexRange(0, bars.length);
  view.fitPriceRange(49_800, 50_300, 0.1);

  let currentMarket = "BTCUSDT";
  const instance = await createIndicatorInstanceAsync("live-trade-bubbles", 0);
  const manager = new IndicatorManager({
    initial: [instance],
    onChange: () => {},
    onLayoutChange: () => {},
    onInvalidate: () => {},
    getChartContext: () => ({ market: currentMarket, timeframe: "1m", intervalMs }),
    headers: createIndicatorPaneHeadersModel(),
  });

  const ctx2d = mockCanvasCtx();
  const drawFrame = () => {
    for (const overlay of manager.getPriceOverlayRenders()) {
      overlay.draw(ctx2d, view, series, { top: 0, height: 300 }, [0, bars.length]);
    }
  };

  // 1. Add & draw -> 1 active subscription with ["trade", "liquidation"] and scope "base".
  drawFrame();
  assert.equal(activeSubs.size, 1);
  const firstSub = Array.from(activeSubs.values())[0];
  assert.equal(firstSub.market, "BTCUSDT");
  assert.deepEqual(firstSub.kinds, ["trade", "liquidation"]);
  assert.equal(firstSub.scope, "base");

  // 2. Hide -> unsubscribes immediately.
  manager.setIndicatorVisible(instance.id, false);
  assert.equal(activeSubs.size, 0);
  drawFrame();
  assert.equal(activeSubs.size, 0);

  // 3. Show again -> re-subscribes.
  manager.setIndicatorVisible(instance.id, true);
  drawFrame();
  assert.equal(activeSubs.size, 1);

  // 4. Kinds change -> old unsubscribed, new subscribed with ["trade"] only.
  manager.restore([{ ...instance, settings: { ...instance.settings, kinds: "trades", scope: "market" } }]);
  drawFrame();
  assert.equal(activeSubs.size, 1);
  const updatedSub = Array.from(activeSubs.values())[0];
  assert.deepEqual(updatedSub.kinds, ["trade"]);
  assert.equal(updatedSub.scope, "market");

  // 5. Market change -> old unsubscribed immediately, new market subscribed on next frame.
  currentMarket = "ETHUSDT";
  manager.handleMarketChange("ETHUSDT");
  assert.equal(activeSubs.size, 0);
  drawFrame();
  assert.equal(activeSubs.size, 1);
  assert.equal(Array.from(activeSubs.values())[0].market, "ETHUSDT");

  // 6. Remove -> unsubscribes immediately.
  manager.deleteIndicator(instance.id);
  assert.equal(activeSubs.size, 0);

  // 7. Restore + dispose -> unsubscribes all, zero leaks.
  const inst2 = await createIndicatorInstanceAsync("live-trade-bubbles", 0);
  manager.restore([inst2]);
  drawFrame();
  assert.equal(activeSubs.size, 1);
  manager.dispose();
  assert.equal(activeSubs.size, 0);
  bubbles.clearLiveTradeEvents();
});

test("two instances on the same market share stream subscription and never double-count nominal (#412)", async () => {
  const {
    bubbles,
    FootprintSeries,
    View,
    createIndicatorInstanceAsync,
    configureIndicatorDataSource,
  } = await loadModules();
  bubbles.clearLiveTradeEvents();

  const listeners = new Map();
  let subSeq = 0;
  let subscribeCalls = 0;

  configureIndicatorDataSource({
    requestLiquidationSeries: () => ({ status: "idle" }),
    requestCoinalyzeDerivativeSeries: () => ({ status: "idle" }),
    requestFuturesPositioningSeries: () => ({ status: "idle" }),
    fetchOptionsGexSurface: async () => { throw new Error("unused"); },
    subscribeLiveTradeEvents(input) {
      subscribeCalls++;
      const token = ++subSeq;
      listeners.set(token, input);
      return () => {
        listeners.delete(token);
      };
    },
  });

  const intervalMs = 60_000;
  const bars = makeBars(5, intervalMs);
  const series = new FootprintSeries({ intervalMs, priceStep: 10 });
  series.loadBars(bars);

  const view = new View();
  view.area = { left: 0, top: 0, width: 600, height: 300 };
  view.setVisibleIndexRange(0, bars.length);
  view.fitPriceRange(49_800, 50_300, 0.1);

  const instA = await createIndicatorInstanceAsync("live-trade-bubbles", 0);
  const instB = await createIndicatorInstanceAsync("live-trade-bubbles", 1);
  let refreshesA = 0;
  let refreshesB = 0;

  const makeCtx = (instance, onRefresh) => ({
    instance,
    settings: instance.settings,
    chart: { market: "BTCUSDT", timeframe: "1m", intervalMs },
    view,
    series,
    requestRefresh: onRefresh,
    theme: {},
  });

  const def = bubbles.liveTradeBubblesIndicatorDefinition;
  def.prepareData(makeCtx(instA, () => { refreshesA++; }));
  def.prepareData(makeCtx(instB, () => { refreshesB++; }));

  assert.equal(subscribeCalls, 1, "identical market/kinds/scope consumers must share a single subscription");
  assert.equal(listeners.size, 1);

  const event1 = {
    id: "btc-140k",
    kind: "trade",
    time: bars[2].startTime + 10_000,
    price: 50_020,
    qty: 2.8,
    notionalUsd: 140_000,
    side: "buy",
    venue: "binance",
  };
  for (const listener of listeners.values()) {
    listener.onEvents([event1]);
  }
  assert.equal(refreshesA, 1);
  assert.equal(refreshesB, 1);

  const prepA = def.prepareData(makeCtx(instA, () => { refreshesA++; }));
  const prepB = def.prepareData(makeCtx(instB, () => { refreshesB++; }));
  assert.equal(prepA.meta.totalEvents, 1);
  assert.equal(prepA.meta.bubbles.length, 1);
  assert.equal(prepA.meta.bubbles[0].count, 1);
  assert.equal(prepA.meta.bubbles[0].notionalUsd, 140_000);
  assert.equal(prepB.meta.totalEvents, 1);
  assert.equal(prepB.meta.bubbles[0].count, 1);
  assert.equal(prepB.meta.bubbles[0].notionalUsd, 140_000);

  // Disposing first instance keeps stream alive for second instance
  const ctxAOff = makeCtx({ ...instA, visible: false }, () => {});
  def.prepareData(ctxAOff);
  assert.equal(listeners.size, 1, "stream stays open while one consumer remains");

  const event2 = {
    id: "btc-90k",
    kind: "trade",
    time: bars[3].startTime + 5_000,
    price: 50_030,
    qty: 1.8,
    notionalUsd: 90_000,
    side: "sell",
    venue: "bybit",
  };
  for (const listener of listeners.values()) {
    listener.onEvents([event2]);
  }
  assert.equal(refreshesB, 2);
  const prepB2 = def.prepareData(makeCtx(instB, () => { refreshesB++; }));
  assert.equal(prepB2.meta.totalEvents, 2);

  // Overlapping subscriptions, bounded dedup, distinct venues/kinds, and base vs market scope isolation
  bubbles.pushLiveTradeEvents("BTCUSDT", [
    event1, // duplicate of existing binance trade
    { ...event1, venue: "bybit" }, // distinct venue must be preserved
    { ...event1, kind: "liquidation", side: "long" }, // distinct kind must be preserved
  ], "base");
  const baseEvents = bubbles.getLiveTradeEvents("BTCUSDT", "base");
  assert.equal(baseEvents.length, 4);

  bubbles.pushLiveTradeEvents("BTCUSDT", [
    { ...event1, id: "market-scope-1", notionalUsd: 75_000 },
  ], "market");
  assert.equal(bubbles.getLiveTradeEvents("BTCUSDT", "market").length, 1);
  assert.equal(bubbles.getLiveTradeEvents("BTCUSDT", "base").length, 4);

  // Close remaining consumer -> active stream drops to 0
  def.prepareData(makeCtx({ ...instB, visible: false }, () => {}));
  assert.equal(listeners.size, 0);
  bubbles.clearLiveTradeEvents();
});

test("marketBuffers enforces MAX_LIVE_TRADE_MARKETS with LRU eviction (#405)", async () => {
  const { bubbles } = await loadModules();
  bubbles.clearLiveTradeEvents();

  const limit = bubbles.MAX_LIVE_TRADE_MARKETS;
  assert.ok(limit >= 8);

  const totalMarkets = limit + 4;
  for (let i = 0; i < totalMarkets; i++) {
    bubbles.pushLiveTradeEvents(`MKT${i}USDT`, [
      { id: `ev-${i}`, kind: "trade", time: 1_700_000_000_000 + i, price: 100, qty: 1, notionalUsd: 50_000, side: "buy", venue: "binance" },
    ]);
  }

  for (let i = 0; i < totalMarkets - limit; i++) {
    assert.equal(bubbles.getLiveTradeEvents(`MKT${i}USDT`).length, 0, `oldest market MKT${i}USDT should be evicted`);
  }

  // Touching the oldest surviving market refreshes it in LRU order so the next eviction removes the following market.
  const oldestSurviving = `MKT${totalMarkets - limit}USDT`;
  const nextOldest = `MKT${totalMarkets - limit + 1}USDT`;
  assert.equal(bubbles.getLiveTradeEvents(oldestSurviving).length, 1);

  bubbles.pushLiveTradeEvents("NEWMKTUSDT", [
    { id: "ev-new", kind: "trade", time: 1_700_000_100_000, price: 100, qty: 1, notionalUsd: 50_000, side: "buy", venue: "binance" },
  ]);

  assert.equal(bubbles.getLiveTradeEvents(oldestSurviving).length, 1);
  assert.equal(bubbles.getLiveTradeEvents(nextOldest).length, 0);
  assert.equal(bubbles.getLiveTradeEvents("NEWMKTUSDT").length, 1);

  bubbles.clearLiveTradeEvents();
});
