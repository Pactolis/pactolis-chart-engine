// T07-A (#320): Frozen exact-hit reference + test-only cheap bounds classification.
// Task type: reference/diagnostic/regression coverage. Development mode: BDD test-only;
// NOT a production-bug RED. Platform scope: shared. CI/browser: NOT_RUN by this author.
//
// Oracle policy: expected picks are HAND-AUTHORED literals derived analytically from the
// view mapping below (screen x = 8*t + 4, screen y = 600 - p); they are independent of
// the production implementation. The `referenceHit` predicate below is a TEST-ONLY
// diagnostic copy of a SUBSET of manager.hitTest semantics (source-read, not imported);
// it does NOT claim the full geometry surface (fibonacci/channels/gann/measure/ellipse/
// triangle/annotation primitives are not copied) is frozen. Parity with referenceHit is
// never the sole oracle: every frozen scenario asserts a literal expected id.
//
// Cheap bounds classification is TEST-ONLY and DYNAMIC: SAFE_BOUNDED requires the
// extension flags to be disabled at query time (plain trend supports extendLeft/
// extendRight, so anchor AABBs alone can false-negative); everything else falls back
// to full scan. No production optimization, no caching, no new framework/dependency.
// refTrendRenderLine freezes trendRenderLine including one-sided rayEnd/rayLeftEnd.

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DrawingManager } from "../dist/features/drawings/drawingManager.js";
import { DRAWING_TOOLS } from "../dist/features/drawings/toolRegistry.js";

// ---------------------------------------------------------------------------
// Deterministic view/context fixture (CSS-native pixel space).
// screenPoint semantics (drawingPrimitives.ts): x = area.left + offsetX + idx*colWidth
// + colWidth/2 ; y = area.top + (priceTop - price)/pricePerPx (linear scale).
// With area {0,0,800,600}, colWidth 8, offsetX 0, priceTop 600, pricePerPx 1:
//   screen(t, p) = { x: 8*t + 4, y: 600 - p }
// ---------------------------------------------------------------------------
const MARKET = "BINANCE_FUTURES:btcusdt";
const TOLERANCE = 7; // manager.hitTest hard-codes tolerance 7.

function makeView(overrides = {}) {
  return {
    area: { left: 0, top: 0, width: 800, height: 600 },
    colWidth: 8,
    offsetX: 0,
    priceTop: 600,
    pricePerPx: 1,
    xOfIndex(index) { return this.area.left + this.offsetX + index * this.colWidth; },
    yOfPrice(price) { return this.area.top + (this.priceTop - price) / this.pricePerPx; },
    ...overrides,
  };
}

const timeCtx = { indexForTime: (t) => t, timeForIndex: (i) => i };
const view = makeView();

function makeManager(drawings) {
  const manager = new DrawingManager(() => {});
  manager.replace(drawings);
  manager.setMarket(MARKET);
  manager.setHitTestContext(view, timeCtx);
  return manager;
}

let idSeq = 0;
function drawing(type, points, extra = {}) {
  return {
    schemaVersion: 2,
    id: extra.id ?? `d${++idSeq}`,
    type,
    points,
    color: "#ffffff",
    lineWidth: 1.5,
    locked: false,
    visible: true,
    market: MARKET,
    ...extra,
  };
}

const A = { time: 10, price: 100 }; // screen (84, 500)
const B = { time: 60, price: 200 }; // screen (484, 400)
// Hand-derived: slope = (400-500)/(484-84) = -0.25, i.e. y = 500 - 0.25*(x-84) on [84,484].
// Key literals: x=284 -> y=450 (midpoint), x=700 -> y=346, x=10 -> y=518.5.
const AT = { x: 84, y: 500 };
// TEST-ONLY reference predicate (diagnostic subset; source-read copy of the
// simple branches of drawingManager.hitTest; live primitives NOT imported).
// ---------------------------------------------------------------------------
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Source-read freeze of production trendRenderLine INCLUDING one-sided rayEnd/
// rayLeftEnd branches (vertical one-way rays; reversed-anchor horizontal rays).
function refTrendRenderLine(d, a, b, v) {
  const extL = d.type === "extended-trend" ? d.extendLeft !== false : d.extendLeft === true;
  const extR = d.type === "extended-trend" || d.type === "trend-ray" ? d.extendRight !== false : d.extendRight === true;
  const L = v.area.left, R = v.area.left + v.area.width, T = v.area.top, Bt = v.area.top + v.area.height;
  const s = (b.y - a.y) / (b.x - a.x);
  if (extL && extR) {
    if (a.x === b.x) return { a: { x: a.x, y: T }, b: { x: a.x, y: Bt } };
    return { a: { x: L, y: a.y + (L - a.x) * s }, b: { x: R, y: a.y + (R - a.x) * s } };
  }
  if (extR) {
    if (a.x === b.x) return { a, b: { x: a.x, y: b.y >= a.y ? Bt : T } };
    return { a, b: { x: R, y: a.y + (R - a.x) * s } };
  }
  if (extL) {
    if (a.x === b.x) return { a: { x: a.x, y: b.y >= a.y ? T : Bt }, b };
    return { a: { x: L, y: a.y + (L - a.x) * s }, b };
  }
  return { a, b };
}

function refZoneBox(d, a, b, v) {
  const rightExtended = (d.type === "extended-rectangle" || d.type === "liquidity-zone" || d.type === "imbalance-zone") && d.extendRight !== false;
  return {
    left: Math.min(a.x, b.x),
    right: d.type === "session-box" ? Math.max(a.x, b.x) : rightExtended ? v.area.left + v.area.width : Math.max(a.x, b.x),
    top: d.type === "session-box" ? v.area.top : Math.min(a.y, b.y),
    bottom: d.type === "session-box" ? v.area.top + v.area.height : Math.max(a.y, b.y),
  };
}

const REFERENCE_TYPES = new Set([
  "horizontal", "horizontal-ray", "vertical", "trend", "trend-ray", "extended-trend",
  "partial-price-line", "rectangle", "extended-rectangle", "session-box",
  "liquidity-zone", "imbalance-zone", "brush", "text", "anchored-vwap",
]);

function referenceHit(d, p, v) {
  if (!d.visible || d.market !== MARKET || d.points.length < 2) return false;
  const a = { x: v.xOfIndex(d.points[0].time) + v.colWidth / 2, y: v.yOfPrice(d.points[0].price) };
  const b = { x: v.xOfIndex(d.points[1].time) + v.colWidth / 2, y: v.yOfPrice(d.points[1].price) };
  if (d.type === "horizontal") return Math.abs(p.y - a.y) <= TOLERANCE;
  if (d.type === "horizontal-ray") return Math.abs(p.y - a.y) <= TOLERANCE && p.x >= Math.max(a.x, v.area.left) - TOLERANCE;
  if (d.type === "vertical") return Math.abs(p.x - a.x) <= TOLERANCE;
  if (d.type === "trend" || d.type === "trend-ray" || d.type === "extended-trend") {
    const line = refTrendRenderLine(d, a, b, v);
    return segDist(p, line.a, line.b) <= TOLERANCE;
  }
  if (d.type === "partial-price-line") {
    return p.x >= Math.min(a.x, b.x) - TOLERANCE && p.x <= Math.max(a.x, b.x) + TOLERANCE && Math.abs(p.y - a.y) <= TOLERANCE;
  }
  if (d.type === "brush") {
    for (let i = 1; i < d.points.length; i++) {
      const pa = { x: v.xOfIndex(d.points[i - 1].time) + v.colWidth / 2, y: v.yOfPrice(d.points[i - 1].price) };
      const pb = { x: v.xOfIndex(d.points[i].time) + v.colWidth / 2, y: v.yOfPrice(d.points[i].price) };
      if (segDist(p, pa, pb) <= TOLERANCE) return true;
    }
    return false;
  }
  if (d.type === "rectangle" || d.type === "extended-rectangle" || d.type === "session-box"
    || d.type === "liquidity-zone" || d.type === "imbalance-zone") {
    const box = refZoneBox(d, a, b, v);
    return p.x >= box.left - TOLERANCE && p.x <= box.right + TOLERANCE
      && p.y >= box.top - TOLERANCE && p.y <= box.bottom + TOLERANCE;
  }
  if (d.type === "text") {
    // Exact mirror of the dedicated production text branch: isAnnotationTool() EXCLUDES "text",
    // so annotationHitTest (callout math, trimmed text) never applies here. No tolerance,
    // no trim; missing text falls back to the default length 3.
    const width = Math.max(32, (d.text?.length ?? 3) * 8);
    return p.x >= a.x && p.x <= a.x + width && p.y >= a.y - 20 && p.y <= a.y + 6;
  }
  if (d.type === "anchored-vwap") return Math.hypot(p.x - a.x, p.y - a.y) <= TOLERANCE;
  return Math.hypot(p.x - a.x, p.y - a.y) <= TOLERANCE || Math.hypot(p.x - b.x, p.y - b.y) <= TOLERANCE;
}

function referencePick(manager, p) {
  for (const d of [...manager.list()].reverse()) if (referenceHit(d, p, view)) return d.id;
  return null;
}
// TEST-ONLY cheap bounds classification (never filters an exact hit). The static
// table documents type-level defaults; queries use the DYNAMIC effectiveClass below
// (extension flags can turn an anchor-bounded plain trend into an unbounded one).
// ---------------------------------------------------------------------------
const CLASSIFICATION = {
  // Safe by default: inside the all-anchor AABB + tolerance, only with flags off (see effectiveClass).
  SAFE_BOUNDED: ["trend", "rectangle", "brush", "partial-price-line"],
  // Unbounded or view-dependent: no sound cheap spatial exclusion -> full scan.
  UNBOUNDED_VIEW_DEPENDENT: [
    "horizontal", "vertical", "horizontal-ray", "trend-ray", "extended-trend",
    "extended-rectangle", "session-box", "liquidity-zone", "imbalance-zone",
    "fibonacci-retracement", "fibonacci-extension", "parallel-channel",
    "regression-channel", "pitchfork", "gann-fan",
  ],
  // Special/unknown geometry (labels, fans, channels, profiles, and unverified
  // primitives such as ellipse/triangle/measure/positions): conservative fallback.
  FALLBACK_SPECIAL: [
    "ellipse", "triangle", "text", "callout-note", "arrow-marker", "arrow-line",
    "date-marker", "event-marker", "measure", "price-range", "date-range",
    "long-position", "short-position", "gann-grid", "anchored-vwap",
    "fixed-range-volume-profile",
  ],
};
// Duplicates detected BEFORE Object.fromEntries (fail loudly, never overwritten).
const classifiedTypes = Object.values(CLASSIFICATION).flat();
if (new Set(classifiedTypes).size !== classifiedTypes.length) throw new Error("duplicate type in CLASSIFICATION");
const CLASS_OF = Object.fromEntries(
  Object.entries(CLASSIFICATION).flatMap(([cls, types]) => types.map((t) => [t, cls])),
);
// Dynamic effective class: SAFE_BOUNDED only for bounded types with flags disabled.
function effectiveClass(d) {
  if (CLASS_OF[d.type] !== "SAFE_BOUNDED" || d.extendLeft === true || d.extendRight === true) return "FALLBACK";
  return "SAFE_BOUNDED";
}

function anchorsAabb(d, v) {
  const xs = d.points.map((pt) => v.xOfIndex(pt.time) + v.colWidth / 2);
  const ys = d.points.map((pt) => v.yOfPrice(pt.price));
  return {
    left: Math.min(...xs) - TOLERANCE, right: Math.max(...xs) + TOLERANCE,
    top: Math.min(...ys) - TOLERANCE, bottom: Math.max(...ys) + TOLERANCE,
  };
}

// Cheap candidate set: SAFE_BOUNDED uses the inflated anchor AABB; everything
// else is always kept (conservative full scan) so no exact hit can be filtered.
function cheapCandidates(drawings, p, v, stats) {
  return drawings.filter((d) => {
    stats.filterCalls += 1;
    if (effectiveClass(d) !== "SAFE_BOUNDED") { stats.fallbackKept += 1; return true; }
    stats.boundComputations += 1;
    const box = anchorsAabb(d, v);
    const keep = p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
    if (keep) stats.candidates += 1;
    return keep;
  });
}
// ---------------------------------------------------------------------------
test("classification table covers the full tool registry exactly once", () => {
  const registryIds = DRAWING_TOOLS.map((t) => t.id);
  assert.equal(new Set(registryIds).size, registryIds.length);
  assert.equal(classifiedTypes.length, registryIds.length); // full coverage, no duplicates
  assert.deepEqual([...new Set(classifiedTypes)].sort(), [...registryIds].sort());
});

test("reverse-linear z-order: topmost of two identical horizontals wins; hidden and other-market excluded; locked still selectable", () => {
  const manager = makeManager([
    drawing("horizontal", [A, A], { id: "low" }),
    drawing("horizontal", [A, A], { id: "top" }),
    drawing("horizontal", [A, A], { id: "hidden", visible: false }),
    drawing("horizontal", [A, A], { id: "other", market: "BINANCE_FUTURES:ethusdt" }),
  ]);
  // Literal: y=500 line of A; overlapping pair -> last in draw order picked.
  assert.equal(manager.hitTestAt({ time: 100, price: 98 }, { x: 804, y: 502 })?.id, "top");
  const m2 = makeManager([
    drawing("horizontal", [A, A], { id: "h1", visible: false }),
    drawing("horizontal", [A, A], { id: "e1", market: "BINANCE_FUTURES:ethusdt" }),
  ]);
  assert.equal(m2.hitTestAt({ time: 10, price: 100 }, AT), null);
  // Locked drawings remain hit-selectable (source-observed: lock blocks drag, not hit).
  const m3 = makeManager([drawing("horizontal", [A, A], { id: "locked", locked: true })]);
  assert.equal(m3.hitTestAt({ time: 10, price: 100 }, AT)?.id, "locked");
  assert.equal(manager.hitTestAt({ time: 300, price: 300 }, { x: 2404, y: 300 }), null);
});

test("unbounded lines: horizontal/vertical span the whole axis; horizontal-ray stops left of anchor", () => {
  const manager = makeManager([
    drawing("horizontal", [A, A], { id: "h" }),
    drawing("vertical", [{ time: 100, price: 300 }, { time: 100, price: 300 }], { id: "v" }),
    drawing("horizontal-ray", [{ time: 400, price: 550 }, { time: 400, price: 550 }], { id: "hr" }),
  ]);
  assert.equal(manager.hitTestAt({ time: 0, price: 101 }, { x: 1, y: 501 })?.id, "h");
  assert.equal(manager.hitTestAt({ time: 100, price: 599 }, { x: 804, y: 1 })?.id, "v");
  // hr: screen y = 600-550 = 50, x >= max(3204, 0)-7 -> right of anchor hits, left misses.
  assert.equal(manager.hitTestAt({ time: 500, price: 552 }, { x: 4004, y: 52 })?.id, "hr");
  assert.equal(manager.hitTestAt({ time: 350, price: 550 }, { x: 2804, y: 50 }), null);
});

test("trend segment, rays and one-way extensions: literal picks with slope -0.25", () => {
  // Line A->B is y = 500 - 0.25*(x-84): midpoint x=284 -> y=450 exactly on segment.
  const mseg = makeManager([drawing("trend", [A, B], { id: "seg" })]);
  assert.equal(mseg.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 })?.id, "seg");
  assert.equal(mseg.hitTestAt({ time: 35, price: 130 }, { x: 284, y: 470 }), null); // 20px off
  // Beyond the anchor AABB (x>484): plain trend misses; trend-ray picks y=346 at x=700.
  const mray = makeManager([drawing("trend-ray", [A, B], { id: "ray" })]);
  assert.equal(mray.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 })?.id, "ray"); assert.equal(mseg.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 }), null);
  // Left extension (x<84): extended-trend picks y=518.5 at x=10, plain trend misses.
  const mext = makeManager([drawing("extended-trend", [A, B], { id: "ext" })]);
  assert.equal(mext.hitTestAt({ time: 1, price: 81.5 }, { x: 10, y: 518.5 })?.id, "ext"); assert.equal(mseg.hitTestAt({ time: 1, price: 81.5 }, { x: 10, y: 518.5 }), null);
  // Reversed anchors [B,A] + extendRight: one-sided ray (484,400)->(800,321); y at x=700 = 346.
  const mrev = makeManager([drawing("trend", [B, A], { id: "rev", extendRight: true })]);
  assert.equal(mrev.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 })?.id, "rev"); assert.equal(mrev.hitTestAt({ time: 1, price: 81.5 }, { x: 10, y: 518.5 }), null);
  // Vertical one-way rays (a=(164,500), b=(164,400)): extendRight-only to pane TOP, extendLeft-only to pane BOTTOM.
  const VPTS = [{ time: 20, price: 100 }, { time: 20, price: 200 }];
  const mvr = makeManager([drawing("trend", VPTS, { id: "vr", extendRight: true })]);
  assert.equal(mvr.hitTestAt({ time: 20, price: 590 }, { x: 164, y: 10 })?.id, "vr"); assert.equal(mvr.hitTestAt({ time: 20, price: 15 }, { x: 164, y: 585 }), null);
  const mvl = makeManager([drawing("trend", VPTS, { id: "vl", extendLeft: true })]);
  assert.equal(mvl.hitTestAt({ time: 20, price: 15 }, { x: 164, y: 585 })?.id, "vl"); assert.equal(mvl.hitTestAt({ time: 20, price: 590 }, { x: 164, y: 10 }), null);
});

test("dynamic extension flags: real style API extends plain trend past anchor AABB, class falls back", () => {
  const manager = makeManager([drawing("trend", [A, B], { id: "t" })]);
  const stats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  assert.equal(effectiveClass(manager.list()[0]), "SAFE_BOUNDED"); // no flags yet
  assert.equal(manager.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 }), null); assert.equal(manager.hitTestAt({ time: 1, price: 81.5 }, { x: 10, y: 518.5 }), null);
  // Real manager API: hitTestAt selects, then one batched style patch (one undo step).
  assert.equal(manager.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 })?.id, "t");
  manager.updateSelectedWithHistory({ extendRight: true });
  assert.equal(manager.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 })?.id, "t");
  // x=700 is outside the anchor AABB [77,491]x[393,507]: only the flag-driven fallback keeps the candidate.
  assert.equal(effectiveClass(manager.list()[0]), "FALLBACK");
  assert.ok(cheapCandidates(manager.list(), { x: 700, y: 346 }, view, stats).some((d) => d.id === "t"));
  manager.updateSelectedWithHistory({ extendLeft: true, extendRight: false }); // swap side
  assert.equal(manager.hitTestAt({ time: 1, price: 81.5 }, { x: 10, y: 518.5 })?.id, "t");
  assert.equal(manager.hitTestAt({ time: 87, price: 254 }, { x: 700, y: 346 }), null);
  assert.ok(cheapCandidates(manager.list(), { x: 10, y: 518.5 }, view, stats).some((d) => d.id === "t"));
});

test("bounded types isolated: partial-price-line/rectangle/trend/brush edges; all candidates kept", () => {
  // ppl [(20,150),(50,90)] normalizes to a flat y=450 segment for x[164,404].
  const manager = makeManager([
    drawing("rectangle", [A, B], { id: "rect" }), // box x[84,484] y[400,500]
    drawing("trend", [{ time: 30, price: 120 }, { time: 55, price: 180 }], { id: "tr" }), // (244,480)-(444,420)
    drawing("brush", [{ time: 65, price: 300 }, { time: 85, price: 300 }], { id: "br" }), // y=300 x[524,684]
    drawing("partial-price-line", [{ time: 20, price: 150 }, { time: 50, price: 90 }], { id: "ppl" }),
  ]);
  assert.equal(manager.list().find((d) => d.id === "ppl").points[1].price, 150);
  // (244,450) hits rect AND ppl (ppl topmost); cheap candidates keep ALL exact-hit candidates.
  assert.equal(manager.hitTestAt({ time: 30, price: 150 }, { x: 244, y: 450 })?.id, "ppl");
  const stats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  const keptIds = cheapCandidates(manager.list(), { x: 244, y: 450 }, view, stats).map((d) => d.id);
  assert.ok(keptIds.includes("ppl") && keptIds.includes("rect") && keptIds.includes("tr"));
  // ppl tolerance edges: x/y at exactly +7 hits, +8 falls through to rect.
  assert.equal(manager.hitTestAt({ time: 50, price: 150 }, { x: 411, y: 450 })?.id, "ppl"); assert.equal(manager.hitTestAt({ time: 51, price: 150 }, { x: 412, y: 450 })?.id, "rect");
  assert.equal(manager.hitTestAt({ time: 30, price: 143 }, { x: 244, y: 457 })?.id, "ppl"); assert.equal(manager.hitTestAt({ time: 30, price: 142 }, { x: 244, y: 458 })?.id, "rect");
  // brush y-edge: hit at exactly 7px, miss at 8px.
  assert.equal(manager.hitTestAt({ time: 75, price: 293 }, { x: 604, y: 307 })?.id, "br"); assert.equal(manager.hitTestAt({ time: 75, price: 292 }, { x: 604, y: 308 }), null);
});

test("zone boxes and brush polyline: bounded box, right extension, full-height session-box, brush segment", () => {
  const manager = makeManager([
    drawing("rectangle", [A, B], { id: "rect" }),
    drawing("brush", [{ time: 10, price: 100 }, { time: 30, price: 100 }, { time: 50, price: 100 }], { id: "br" }),
  ]);
  // rect box x[84,484], y[400,500]: interior pick; brush (later in order) wins on its line.
  assert.equal(manager.hitTestAt({ time: 30, price: 150 }, { x: 244, y: 450 })?.id, "rect");
  assert.equal(manager.hitTestAt({ time: 80, price: 150 }, { x: 644, y: 450 }), null);
  // brush: horizontal segments at y=500 for x in [84,404]; near pick, far miss.
  assert.equal(manager.hitTestAt({ time: 30, price: 103 }, { x: 244, y: 503 })?.id, "br");
  assert.equal(manager.hitTestAt({ time: 30, price: 130 }, { x: 244, y: 530 }), null);

  const mz = makeManager([
    drawing("extended-rectangle", [A, B], { id: "xr" }),
    drawing("session-box", [A, B], { id: "sb" }),
  ]);
  // xr right edge extends to the view right edge (800): far-right interior picks.
  assert.equal(mz.hitTestAt({ time: 85, price: 150 }, { x: 684, y: 450 })?.id, "xr");
  // sb spans the full plot height for x[84,484]: top strip picks.
  assert.equal(mz.hitTestAt({ time: 30, price: 580 }, { x: 244, y: 20 })?.id, "sb");
});

test("special geometry fallback witness: text label box and screenless anchor fallback", () => {
  const manager = makeManager([
    drawing("text", [A, A], { id: "txt", text: "hello" }), // box x[84,124], y[480,506]
    drawing("anchored-vwap", [A, A], { id: "vw" }),
  ]);
  assert.equal(manager.hitTestAt({ time: 12, price: 105 }, { x: 100, y: 495 })?.id, "txt");
  assert.equal(manager.hitTestAt({ time: 40, price: 105 }, { x: 324, y: 495 }), null);
  // Both-direction witnesses against the annotation-callout box confusion (callout math
  // x[87,157] y[457,495]); the actual production text box is exactly x[84,124] y[480,506].
  assert.equal(manager.hitTestAt({ time: 12, price: 98 }, { x: 100, y: 502 })?.id, "txt"); // actual HIT; callout box would MISS
  assert.equal(manager.hitTestAt({ time: 18, price: 102 }, { x: 150, y: 470 }), null); // callout box would HIT; actual MISS
  assert.equal(manager.hitTestAt({ time: 12, price: 105 }, { x: 124, y: 480 })?.id, "txt"); // exact box corner
  assert.equal(manager.hitTestAt({ time: 12, price: 105 }, { x: 125, y: 480 }), null); // 1px right of box
  assert.equal(manager.hitTestAt({ time: 12, price: 105 }, { x: 100, y: 506 })?.id, "txt"); // exact bottom edge
  assert.equal(manager.hitTestAt({ time: 12, price: 105 }, { x: 100, y: 507 }), null); // 1px below box
  // Missing-text fallback witness: default length 3 -> width 32 -> box x[84,116].
  const mt = makeManager([drawing("text", [A, A], { id: "txtd" })]);
  assert.equal(mt.hitTestAt({ time: 13, price: 105 }, { x: 110, y: 495 })?.id, "txtd");
  assert.equal(mt.hitTestAt({ time: 14, price: 105 }, { x: 118, y: 495 }), null);
  // anchored-vwap: only within 7px of anchor A (84,500).
  assert.equal(manager.hitTestAt({ time: 11, price: 103 }, { x: 88, y: 503 })?.id, "vw");
  // Screenless conservative fallback: anchor-distance <= 1 in (time, price) units.
  const m = makeManager([drawing("trend", [A, B], { id: "seg" })]);
  assert.equal(m.hitTestAt({ time: 10, price: 100.5 })?.id, "seg");
  assert.equal(m.hitTestAt({ time: 35, price: 150 }), null);
});

test("DPR 1/2 CSS-native coordinate equivalence (unit-level, not a GPU/browser claim)", () => {
  const manager = makeManager([drawing("rectangle", [A, B], { id: "r" })]);
  // The hit pipeline consumes CSS pixels only; a different device pixel ratio of the
  // backing store cannot change the pick when the CSS mapping is identical.
  const q = { x: 244, y: 450 };
  const pick1 = manager.hitTestAt({ time: 30, price: 150 }, q)?.id;
  manager.setHitTestContext(makeView(), timeCtx); // identical CSS mapping
  const pick2 = manager.hitTestAt({ time: 30, price: 150 }, q)?.id;
  assert.equal(pick1, "r");
  assert.equal(pick1, pick2);
});

test("cheap bounds classification never filters an exact hit and matches the reference on the reference subset", () => {
  const corpus = [
    drawing("horizontal", [A, A], { id: "c-h" }),
    drawing("trend", [A, B], { id: "c-t" }),
    drawing("trend-ray", [A, B], { id: "c-tr" }),
    drawing("extended-trend", [A, B], { id: "c-et" }),
    drawing("rectangle", [A, B], { id: "c-r" }),
    drawing("extended-rectangle", [A, B], { id: "c-er" }),
    drawing("brush", [{ time: 10, price: 100 }, { time: 30, price: 120 }, { time: 50, price: 100 }], { id: "c-b" }),
    drawing("text", [A, A], { id: "c-x", text: "note" }),
    drawing("anchored-vwap", [A, A], { id: "c-v" }),
  ];
  corpus.forEach((d) => assert.ok(REFERENCE_TYPES.has(d.type), `uncovered reference type ${d.type}`));
  const queries = [
    { x: 284, y: 450 }, { x: 700, y: 346 }, { x: 10, y: 518.5 }, { x: 244, y: 450 },
    { x: 684, y: 450 }, { x: 100, y: 495 }, { x: 88, y: 503 }, { x: 804, y: 502 },
    { x: 244, y: 530 }, { x: 400, y: 100 },
  ];
  const manager = makeManager(corpus);
  const stats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  for (const q of queries) {
    const exact = manager.hitTestAt({ time: 30, price: 150 }, q);
    const ref = referencePick(manager, q);
    assert.equal(exact?.id ?? null, ref, `parity drift at ${JSON.stringify(q)}`);
    const candidates = cheapCandidates(manager.list(), q, view, stats).map((d) => d.id);
    if (exact) assert.ok(candidates.includes(exact.id), `cheap filter dropped exact hit ${exact.id}`);
  }
  // Isolated real-manager witness: each corpus drawing ALONE under the same public API
  // (replace/setMarket/setHitTestContext/hitTestAt) must survive the full-corpus cheap
  // candidate set for every query above. Midpoint (284,450) independently yields the
  // five literal hits below, so the inclusion claim is not vacuous.
  const isolatedHits = (q2) => corpus
    .map((d) => makeManager([structuredClone(d)]).hitTestAt({ time: 30, price: 150 }, q2)?.id ?? null)
    .filter(Boolean);
  assert.deepEqual(isolatedHits(queries[0]).sort(), ["c-er", "c-et", "c-r", "c-t", "c-tr"]);
  for (const q2 of queries) {
    const candidateIds = cheapCandidates(manager.list(), q2, view, stats).map((d) => d.id);
    for (const hitId of isolatedHits(q2)) {
      assert.ok(candidateIds.includes(hitId), `cheap filter dropped isolated hit ${hitId} at ${JSON.stringify(q2)}`);
    }
  }
  assert.ok(stats.filterCalls > 0);
});

test("view/pane/style change invalidates cached test-only bounds (stale bounds reclassified)", () => {
  const manager = makeManager([drawing("rectangle", [A, B], { id: "r" })]);
  const stats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  const stale = anchorsAabb(manager.list()[0], view); // box x[77,491], y[393,507]
  // Pan the view right by one column: every anchor screen x shifts by +8.
  const panned = makeView({ offsetX: 8 });
  manager.setHitTestContext(panned, timeCtx);
  const fresh = anchorsAabb(manager.list()[0], panned); // box x[85,499]
  assert.notDeepEqual(stale, fresh);
  // x=493 lies outside the stale box but inside the rebuilt one: the stale bound
  // would drop it, yet the production exact pick still returns the drawing.
  assert.ok(!(493 >= stale.left && 493 <= stale.right));
  assert.equal(manager.hitTestAt({ time: 31, price: 150 }, { x: 493, y: 450 })?.id, "r");
  const candidates = cheapCandidates(manager.list(), { x: 493, y: 450 }, panned, stats);
  assert.ok(candidates.some((d) => d.id === "r"));
  // Style change (visibility flip) also requires re-reading live state, not bounds.
  manager.setVisible("r", false);
  assert.equal(manager.hitTestAt({ time: 31, price: 150 }, { x: 493, y: 450 }), null);
  manager.setVisible("r", true);
  assert.equal(manager.hitTestAt({ time: 31, price: 150 }, { x: 493, y: 450 })?.id, "r");
});

test("zoom and pane/scale change: stale-view bound provably misses, fresh bound and public pick agree", () => {
  // Zoom (colWidth 16): screen x = 16*t + 8; A -> (168,500), B -> (968,400).
  const zoomView = makeView({ colWidth: 16 });
  const zr = makeManager([drawing("rectangle", [A, B], { id: "zr" })]);
  const staleZoom = anchorsAabb(zr.list()[0], view); // old-view box x[77,491] y[393,507]
  const freshZoom = anchorsAabb(zr.list()[0], zoomView); // x[161,975] y[393,507]
  // (600,450) -> raw time 37, price 150: outside the stale box, inside the fresh one.
  assert.ok(!(600 >= staleZoom.left && 600 <= staleZoom.right));
  assert.ok(600 >= freshZoom.left && 600 <= freshZoom.right && 450 >= freshZoom.top && 450 <= freshZoom.bottom);
  zr.setHitTestContext(zoomView, timeCtx);
  assert.equal(zr.hitTestAt({ time: 37, price: 150 }, { x: 600, y: 450 })?.id, "zr");
  const zstats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  assert.ok(cheapCandidates(zr.list(), { x: 600, y: 450 }, zoomView, zstats).some((d) => d.id === "zr"));
  // Pane/scale change (left 50, top 40, height 400, pricePerPx 2): A -> (134,290), B -> (534,240).
  const paneView = makeView({ area: { left: 50, top: 40, width: 800, height: 400 }, pricePerPx: 2 });
  const pr = makeManager([drawing("rectangle", [A, B], { id: "pr" })]);
  const stalePane = anchorsAabb(pr.list()[0], view); // y[393,507]
  const freshPane = anchorsAabb(pr.list()[0], paneView); // x[127,541] y[233,297]
  // (400,270) -> raw time 43.25, price 140 = 600 - (270-40)*2.
  assert.ok(!(270 >= stalePane.top && 270 <= stalePane.bottom));
  assert.ok(400 >= freshPane.left && 400 <= freshPane.right && 270 >= freshPane.top && 270 <= freshPane.bottom);
  pr.setHitTestContext(paneView, timeCtx);
  assert.equal(pr.hitTestAt({ time: 43.25, price: 140 }, { x: 400, y: 270 })?.id, "pr");
  const pstats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0 };
  assert.ok(cheapCandidates(pr.list(), { x: 400, y: 270 }, paneView, pstats).some((d) => d.id === "pr"));
});

test("creation via public pointer API: draft placement, literal on-segment hit, undo/redo, tool reset", () => {
  const manager = new DrawingManager(() => {});
  manager.setMarket(MARKET);
  manager.setHitTestContext(view, timeCtx);
  manager.setTool("trend");
  assert.equal(manager.activeTool, "trend");
  // Before creation: the midpoint and the 20px-off control both miss.
  assert.equal(manager.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 }), null);
  assert.equal(manager.hitTestAt({ time: 35, price: 130 }, { x: 284, y: 470 }), null);
  assert.equal(manager.pointerDown({ ...A }, AT), true);
  assert.equal(manager.hasDraft(), true);
  assert.deepEqual(manager.getPlacementStatus(), { state: "placing", remainingAnchors: 1, requiredAnchors: 2 });
  assert.equal(manager.pointerMove({ ...B }), true);
  assert.equal(manager.pointerUp(), true);
  assert.equal(manager.hasDraft(), false);
  const created = manager.list();
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "trend");
  assert.equal(created[0].market, MARKET);
  assert.equal(created[0].dataState, "ready");
  assert.ok(typeof created[0].id === "string" && created[0].id.length > 0); // random id: identity only
  assert.equal(created[0].points[0].time, 10);
  assert.equal(created[0].points[0].price, 100);
  assert.equal(created[0].points[1].time, 60);
  assert.equal(created[0].points[1].price, 200);
  const createdId = created[0].id;
  // After creation: midpoint hits the committed segment; the 20px-off control still misses.
  assert.equal(manager.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 })?.id, createdId);
  assert.equal(manager.hitTestAt({ time: 35, price: 130 }, { x: 284, y: 470 }), null);
  // Tool reset after commit: activeTool getter is null; a bare pointerDown selects nothing.
  assert.equal(manager.activeTool, null);
  assert.equal(manager.pointerDown({ time: 35, price: 130 }, { x: 284, y: 470 }), false);
  assert.equal(manager.hasDraft(), false);
  manager.undo();
  assert.equal(manager.list().length, 0);
  assert.equal(manager.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 }), null);
  manager.redo();
  assert.equal(manager.list().length, 1);
  assert.equal(manager.hitTestAt({ time: 35, price: 150 }, { x: 284, y: 450 })?.id, createdId);
});

test("drag/move via real pointer API, delete, undo/redo and replace keep literal picks and z-order", () => {
  const manager = makeManager([
    drawing("trend", [A, B], { id: "seg" }),
    drawing("horizontal", [{ time: 20, price: 300 }, { time: 20, price: 300 }], { id: "h" }), // y=300, far away
  ]);
  // pointerDown on anchor A selects "seg" and targets the nearest anchor (index 0);
  // pointerMove edits that anchor absolutely to (30,110); pointerUp commits history.
  assert.equal(manager.pointerDown({ time: 10, price: 100 }, AT), true);
  assert.equal(manager.pointerMove({ time: 30, price: 110 }), true);
  assert.equal(manager.pointerUp(), true);
  const moved = manager.list().find((d) => d.id === "seg");
  assert.deepEqual(moved.points[0], { time: 30, price: 110 });
  assert.deepEqual(moved.points[1], B); // point-edit moves one anchor only
  // Moved segment (244,490)-(484,400): slope -0.375, y at x=364 is 445.
  assert.equal(manager.hitTestAt({ time: 45, price: 155 }, { x: 364, y: 445 })?.id, "seg");
  manager.delete("seg");
  assert.equal(manager.hitTestAt({ time: 45, price: 155 }, { x: 364, y: 445 }), null);
  manager.undo();
  assert.equal(manager.hitTestAt({ time: 45, price: 155 }, { x: 364, y: 445 })?.id, "seg");
  manager.redo();
  assert.equal(manager.hitTestAt({ time: 45, price: 155 }, { x: 364, y: 445 }), null);
  manager.undo();
  // Replace resets state; z-order topmost literal pick preserved.
  manager.replace([drawing("horizontal", [A, A], { id: "z1" }), drawing("horizontal", [A, A], { id: "z2" })]);
  assert.equal(manager.hitTestAt({ time: 10, price: 100 }, AT)?.id, "z2");
});

test("geometry clone returned by hitTestAt; selection state is manager-owned and mutable", () => {
  const source = [drawing("rectangle", [A, B], { id: "r" })];
  const manager = makeManager(source);
  const pick = manager.hitTestAt({ time: 30, price: 150 }, { x: 244, y: 450 });
  assert.equal(pick.id, "r");
  // hitTestAt ALSO mutates manager selection (intended behavior, not selection immutability).
  assert.deepEqual(manager.getSelectedIds(), ["r"]);
  pick.points[0].price = 999; // mutate the returned clone only
  assert.equal(manager.list()[0].points[0].price, 100);
  source[0].visible = false; // input array is not the live state after replace()
  assert.equal(manager.list()[0].visible, true);
  for (const d of manager.list()) assert.equal(typeof JSON.stringify(d), "string");
});

// ---------------------------------------------------------------------------
// Performance report (REPORT ONLY): 100/500/1000 drawings, deterministic analytic
// corpus (no RNG: index-derived fillers provably miss all 48 fixed screen queries;
// 8 hand-authored markers carry the literal hit/miss/overlap expected ids, asserted
// for BOTH the exact hitTestAt pick and the diagnostic cheap pick). Warmup runs both
// actual paths over the same 48 queries; maintenance (classification + bounds
// rebuild) is timed separately and amortized once per 48-query cycle. No threshold,
// no failure, no GO claim; Node algorithm measurements only, browser NOT_RUN.
// ---------------------------------------------------------------------------
const q = (x, y, e) => ({ x, y, e });
const PERF_QUERIES = [
  q(244, 450, "m-ppl"), q(484, 507, "m-rect"), q(492, 450, null), q(84, 393, "m-rect"), q(84, 392, null), q(200, 450, "m-ppl"), q(444, 420, "m-trend"), q(244, 480, "m-trend"), q(344, 455, "m-ppl"), q(344, 458, "m-rect"), q(444, 428, "m-rect"), q(344, 430, "m-rect"),
  q(411, 450, "m-ppl"), q(412, 450, "m-rect"), q(244, 457, "m-ppl"), q(244, 458, "m-rect"), q(100, 450, "m-rect"), q(164, 450, "m-ppl"), q(600, 300, "m-brush"), q(524, 300, "m-brush"), q(691, 300, "m-brush"), q(692, 300, null), q(600, 307, "m-brush"), q(600, 308, null),
  q(644, 530, "m-over2"), q(564, 510, "m-over2"), q(724, 550, "m-over2"), q(731, 530, "m-over2"), q(732, 530, null), q(644, 517, "m-over2"), q(16, 12, "m-far"), q(28, 20, "m-far"), q(35, 12, "m-far"), q(36, 12, null), q(16, 27, "m-far"), q(16, 28, null),
  q(400, 350, "m-h"), q(1, 350, "m-h"), q(799, 350, "m-h"), q(400, 357, "m-h"), q(400, 358, null), q(400, 343, "m-h"), q(644, 545, "m-over2"), q(644, 557, "m-over2"), q(644, 558, null), q(564, 503, "m-over2"), q(556, 530, null), q(16, 5, "m-far"),
];
// q(344,455): both m-trend (5px off its line) and m-ppl (5px off y=450) hit; m-ppl is later, so it wins.
const PERF_MARKERS = [ // appended last: later markers win overlaps (z-order literals)
  drawing("rectangle", [A, B], { id: "m-rect" }), // box x[84,484] y[400,500]
  drawing("trend", [{ time: 30, price: 120 }, { time: 55, price: 180 }], { id: "m-trend" }), // (244,480)-(444,420)
  drawing("partial-price-line", [{ time: 20, price: 150 }, { time: 50, price: 150 }], { id: "m-ppl" }), // y=450 x[164,404]
  drawing("brush", [{ time: 65, price: 300 }, { time: 75, price: 300 }, { time: 85, price: 300 }], { id: "m-brush" }), // y=300 x[524,684]
  drawing("rectangle", [{ time: 70, price: 50 }, { time: 90, price: 90 }], { id: "m-over1" }), // x[564,724] y[510,550]
  drawing("rectangle", [{ time: 70, price: 50 }, { time: 90, price: 90 }], { id: "m-over2" }), // same box, later
  drawing("rectangle", [{ time: 0, price: 580 }, { time: 3, price: 595 }], { id: "m-far" }), // x[4,28] y[5,20]
  drawing("horizontal", [{ time: 40, price: 250 }, { time: 40, price: 250 }], { id: "m-h" }), // y=350 unbounded
];
function perfCorpus(count) {
  const types = ["rectangle", "trend", "brush", "partial-price-line"];
  const fillers = [];
  for (let i = 0; i < count - PERF_MARKERS.length; i++) {
    const t1 = 1 + (i % 5), t2 = t1 + 1 + (i % 3); // anchor screen x <= 76, box right <= 83
    const p1 = 200 + (i % 8) * 30, p2 = p1 + 20 + (i % 5) * 15; // y bands within [103,407]
    const type = types[i % 4];
    fillers.push(drawing(type, type === "brush"
      ? [{ time: t1, price: p1 }, { time: t2, price: p2 }, { time: t2 + 1, price: p1 }]
      : [{ time: t1, price: p1 }, { time: t2, price: p2 }], { id: `f${i}` }));
  }
  // Fillers provably miss every query: query points with x <= 83 sit at y in [5,28] or x = 1 (left of every filler box).
  return [...fillers, ...PERF_MARKERS.map((m) => structuredClone(m))];
}
test("bounded workload report: exact hitTestAt vs test-only diagnostic cheap query (report only)", () => {
  const report = { seed: 20260809, corpus: "analytic deterministic (no RNG)", queries: PERF_QUERIES.length, node: process.version, platform: process.platform, source: { head: process.env.GITHUB_SHA ?? "local-node", ref: process.env.GITHUB_REF ?? null }, browser: "NOT_RUN", counts: {} };
  const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  for (const count of [100, 500, 1000]) {
    const manager = makeManager(perfCorpus(count));
    const snapshot = manager.list();
    const stats = { filterCalls: 0, boundComputations: 0, candidates: 0, fallbackKept: 0, exactCalls: 0, diagnosticCalls: 0 };
    const buildBounds = () => snapshot.map((d) => effectiveClass(d) === "SAFE_BOUNDED" ? { d, box: anchorsAabb(d, view) } : { d, box: null });
    const diagQuery = (p, bounds) => {
      stats.diagnosticCalls += 1;
      for (let i = bounds.length - 1; i >= 0; i--) {
        const { d, box } = bounds[i];
        stats.filterCalls += 1;
        if (!box) stats.fallbackKept += 1;
        else if (p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom) stats.candidates += 1;
        else continue;
        if (referenceHit(d, p, view)) return d.id;
      }
      return null;
    };
    const exactQuery = (p) => { stats.exactCalls += 1; return manager.hitTestAt({ time: 10, price: 100 }, p)?.id ?? null; };
    const maintenanceSamples = Array.from({ length: 5 }, () => { const t0 = performance.now(); buildBounds(); return performance.now() - t0; });
    for (let w = 0; w < 2; w++) { // warmup: BOTH actual paths, same 48 queries
      const warmBounds = buildBounds();
      for (const p of PERF_QUERIES) { exactQuery(p); diagQuery(p, warmBounds); }
    }
    const exactSamples = PERF_QUERIES.map((p) => { const t0 = performance.now(); const id = exactQuery(p); return { dt: performance.now() - t0, id, p }; });
    const bounds = buildBounds();
    const diagSamples = PERF_QUERIES.map((p) => { const t0 = performance.now(); const id = diagQuery(p, bounds); return { dt: performance.now() - t0, id, p }; });
    let hits = 0;
    for (const r of exactSamples) { assert.equal(r.id, r.p.e, `exact drift at ${r.p.x},${r.p.y}`); if (r.p.e) hits += 1; }
    for (const r of diagSamples) assert.equal(r.id, r.p.e, `diagnostic drift at ${r.p.x},${r.p.y}`);
    report.counts[count] = { drawings: snapshot.length, queries: PERF_QUERIES.length, warmupCycles: 2, measuredCycles: 1, maintenanceRebuilds: 5, expectedHits: hits, expectedMisses: PERF_QUERIES.length - hits,
      exactHitTestAtMs: { p50: +pct(exactSamples.map((r) => r.dt), 0.5).toFixed(3), p95: +pct(exactSamples.map((r) => r.dt), 0.95).toFixed(3) }, diagnosticCheapMs: { p50: +pct(diagSamples.map((r) => r.dt), 0.5).toFixed(3), p95: +pct(diagSamples.map((r) => r.dt), 0.95).toFixed(3) },
      maintenanceBoundsMs: { p50: +pct(maintenanceSamples, 0.5).toFixed(3), p95: +pct(maintenanceSamples, 0.95).toFixed(3) }, totalDiagnosticMsAmortized: +(diagSamples.reduce((s, r) => s + r.dt, 0) + pct(maintenanceSamples, 0.5)).toFixed(3), calls: { ...stats } };
  }
  console.log(`drawingHitReference perf report (REPORT ONLY, no threshold): ${JSON.stringify(report)}`);
});
