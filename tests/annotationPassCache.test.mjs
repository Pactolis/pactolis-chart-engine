import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationPassCache, annotationPass } from "../dist/core/render/overlay/annotationPassCache.js";
import { ChartChange } from "../dist/core/render/scene/chartScene.js";

function fixture() {
  const images = [];
  const make = () => {
    const canvas = { width: 64, height: 32, ownerDocument: { createElement: () => make().canvas } };
    const ctx = { canvas, save() {}, restore() {}, setTransform() {}, getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), drawImage: (...args) => images.push(args) };
    canvas.getContext = () => ctx;
    return ctx;
  };
  return { ctx: make(), images };
}

test("pass interests retain closed output through tail frames and invalidate on autoscale", () => {
  const cache = new AnnotationPassCache();
  const { ctx, images } = fixture();
  let paints = 0, effects = 0;
  const draw = () => { paints++; return 7; };
  const paint = (changes, key = "fixed") => {
    cache.begin(changes, key);
    return cache.render(ctx, annotationPass("axis"), "", changes, draw, (value) => { effects += value; });
  };
  assert.equal(paint(ChartChange.All), "miss");
  assert.equal(paint(ChartChange.DataTail), "hit");
  assert.equal(paint(ChartChange.DataTail), "hit");
  assert.equal(paints, 1);
  assert.equal(effects, 14);
  assert.equal(images.length, 3);
  paint(ChartChange.DataTail | ChartChange.Viewport, "expanded-price-range");
  assert.equal(paints, 2);
  paint(ChartChange.DataTail, "new-bar");
  assert.equal(paints, 3);
  cache.clear();
});

test("tail-dependent indicators and last price never reuse a static pass", () => {
  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  cache.begin(ChartChange.DataTail, "fixed");
  for (const id of ["last-price", "indicators", "indicator:ema", "volume-profile", "tpo", "orderbook-heatmap"]) {
    let called = false;
    assert.equal(cache.render(ctx, annotationPass(id), "", ChartChange.DataTail, () => { called = true; }, () => {}), false);
    assert.equal(called, false);
  }
});

test("cache is bounded and absent canvas capabilities use the direct path", () => {
  const cache = new AnnotationPassCache();
  const { ctx } = fixture();
  ctx.canvas.width = 10000;
  ctx.canvas.height = 10000;
  cache.begin(ChartChange.All, "large");
  assert.equal(cache.render(ctx, annotationPass("drawings"), "", ChartChange.All, () => {}, () => {}), false);
  ctx.canvas.width = 64;
  ctx.canvas.ownerDocument = null;
  assert.equal(cache.render(ctx, annotationPass("drawings"), "", ChartChange.All, () => {}, () => {}), false);
});
