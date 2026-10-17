import test from "node:test";
import assert from "node:assert/strict";
import { ChartChange, ChartSurfaceDirty } from "../dist/core/render/scene/chartScene.js";
import { ChartSession } from "../dist/features/chart/ChartSession.js";

// External intent oracle: canvas setters clear a previously painted bitmap, regardless
// of whether the numeric assignment changes it. The ledger observes public lifecycle,
// owner callbacks and render effects; it never reads/patches ChartSession internals.
function fixture(t, hooks = {}) {
  const ledger = [];
  let tick = 0;
  let frame = null;
  const record = (kind, detail = {}) => ledger.push({ kind, ...detail, frame, timestamp: ++tick });
  const observers = [];
  class RO {
    constructor(callback) { this.callback = callback; this.observed = false; observers.push(this); }
    observe() { this.observed = true; }
    disconnect() { this.observed = false; }
    trigger() { this.callback([]); }
  }
  function owner(name, dpr) {
    let id = 0;
    const queue = new Map(), media = new Set();
    return {
      name, devicePixelRatio: dpr, ResizeObserver: RO,
      requestAnimationFrame(cb) { queue.set(++id, cb); return id; },
      cancelAnimationFrame(key) { record("cancel", { owner: name, id: key }); queue.delete(key); },
      queued: () => queue.size,
      run() {
        const entry = queue.entries().next().value;
        assert.ok(entry, "a real owner RAF must be queued");
        queue.delete(entry[0]);
        assert.equal(frame, null);
        frame = name + ":" + entry[0];
        record("enter");
        try { entry[1](tick); } finally { record("leave"); frame = null; }
      },
      media() { for (const cb of [...media]) cb(); },
      listeners: () => media.size,
      matchMedia() {
        return {
          addEventListener(_type, cb) { media.add(cb); },
          removeEventListener(_type, cb) { media.delete(cb); },
        };
      },
    };
  }
  const win = owner("A", 2);
  const doc = {
    defaultView: win,
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0, height: 0,
        getContext() {
          return {
            createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData() { record("encode-pixels"); },
            drawImage(canvas) { assert.equal(canvas, canvases[1]); record("encode-annotation"); },
          };
        },
        toBlob(cb, type) { assert.equal(type, "image/png"); cb(new Blob(["fixture"], { type })); },
      };
    },
  };
  const size = { width: 640, height: 360 };
  const container = document => ({
    ownerDocument: document,
    getBoundingClientRect: () => ({ ...size }),
  });
  const view = { colWidth: 11, offsetX: 37, priceTop: 240, pricePerPx: 0.5,
    area: { left: 0, top: 0, width: 0, height: 0 } };
  const counts = { gpu: 0, annotation: 0, interaction: 0 };
  const gl = {
    RGBA: 6408, UNSIGNED_BYTE: 5121,
    readPixels(_x, _y, w, h, _format, _type, bytes) {
      assert.equal(canvases[0].painted, true, "readPixels must see this frame's GPU draw");
      record("readPixels", { width: w, height: h });
      bytes.fill(255);
    },
  };
  function canvas(name) {
    const events = new Map();
    let width = 0, height = 0;
    return {
      ownerDocument: doc, style: {}, painted: false, resets: 0,
      get width() { return width; },
      set width(value) { width = value; this.painted = false; this.resets++; record("reset", { surface: name, axis: "width", value }); },
      get height() { return height; },
      set height(value) { height = value; this.painted = false; this.resets++; record("reset", { surface: name, axis: "height", value }); },
      getContext(kind) { return kind === "webgl2" ? gl : null; },
      addEventListener(type, cb) { events.set(type, cb); },
      removeEventListener(type) { events.delete(type); },
      dispatch(type) { events.get(type)?.({ preventDefault() {} }); },
      listeners: () => events.size,
    };
  }
  const canvases = ["gpu", "annotation", "interaction"].map(canvas);
  const context = name => ({ setTransform(...values) { record("transform", { surface: name, values }); hooks.transform?.(name); } });
  function paint(name, index) {
    counts[name]++;
    canvases[index].painted = true;
    record("paint", { surface: name, width: canvases[index].width, height: canvases[index].height,
      area: { ...view.area }, colWidth: view.colWidth, offsetX: view.offsetX });
  }
  const session = new ChartSession({
    container: container(doc), ownerDocument: doc, gl,
    gpuCanvas: canvases[0], annotationCanvas: canvases[1], interactionCanvas: canvases[2],
    annotationCtx2d: context("annotation"), interactionCtx2d: context("interaction"),
    renderer: { render() { paint("gpu", 0); }, visibleRange() { return [0, 0]; } },
    annotation: { render() { paint("annotation", 1); } },
    interaction: { render() { paint("interaction", 2); } },
    view, series: { length: 1 }, crosshair: { visible: false, x: 0, y: 0 },
    onRestoreContext() { record("restore"); },
    onResize(w, h, dpr) {
      record("adapt", { width: w, height: h, dpr });
      view.area = { left: 0, top: 0, width: w - 64, height: h - 20 }; hooks.resize?.(w, h, dpr);
    },
    onRendered(surfaces, changes) { record("rendered", { surfaces, changes }); },
  });
  const ro = observers.at(-1);
  t.after(() => session.destroy());
  session.activate();
  win.run();
  assert.deepEqual(counts, { gpu: 1, annotation: 1, interaction: 1 });
  assert.ok(canvases.every(c => c.painted), "all three initial bitmaps are positively painted");
  return { session, win, doc, owner, container, observers, ro, size, view, counts, canvases, ledger };
}
const snapshot = h => h.canvases.map(c => ({ width: c.width, height: c.height, resets: c.resets, painted: c.painted }));
function retained(h, before) {
  assert.deepEqual(snapshot(h), before, "measurement/notification must not clear ANY previously painted bitmap before owned RAF");
}
function atomic(h, mark, ownerName, dimensions, area) {
  const events = h.ledger.slice(mark);
  const enter = events.find(e => e.kind === "enter");
  assert.ok(enter && enter.frame.startsWith(ownerName + ":"), "commit must run on the actual owner RAF");
  const resets = events.filter(e => e.kind === "reset");
  assert.deepEqual(resets.map(e => e.surface), ["gpu", "gpu", "annotation", "annotation", "interaction", "interaction"],
    "each changed width/height clears exactly once on all three physical surfaces");
  for (const e of events.filter(e => ["reset", "transform", "adapt", "paint", "readPixels", "rendered"].includes(e.kind))) {
    assert.equal(e.frame, enter.frame, e.kind + " must complete within the same owned callback");
  }
  const paints = events.filter(e => e.kind === "paint");
  assert.deepEqual(paints.map(e => e.surface), ["gpu", "annotation", "interaction"]);
  assert.ok(resets.every(e => e.timestamp < paints[0].timestamp), "all bitmap resets precede painting; none can erase a completed pass");
  const adapt = events.filter(e => e.kind === "adapt");
  assert.equal(adapt.length, 1, "coalesced measurements adapt once");
  assert.ok(adapt[0].timestamp < paints[0].timestamp, "view adaptation precedes the three draw passes");
  for (const e of paints) {
    assert.deepEqual([e.width, e.height], dimensions);
    assert.deepEqual(e.area, area);
    assert.equal(e.colWidth, 11, "manual horizontal zoom is caller-owned");
    assert.equal(e.offsetX, 37, "manual horizontal position is caller-owned");
  }
  assert.ok(h.canvases.every(c => c.painted), "no surface remains clear when RAF returns");
  assert.deepEqual(h.ledger.at(-1).kind, "leave");
  assert.equal(h.ledger.at(-1).frame, enter.frame);
  assert.equal(h.win.queued(), 0);
}

test("atomic resize positive control: unchanged measurements and interaction do not reset bitmaps", t => {
  const h = fixture(t), before = snapshot(h), mark = h.ledger.length;
  h.ro.trigger(); h.win.media();
  retained(h, before);
  assert.equal(h.win.queued(), 0);
  h.session.invalidate(ChartChange.Interaction);
  assert.equal(h.win.queued(), 1);
  h.win.run();
  retained(h, before);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 2 });
  assert.equal(h.ledger.slice(mark).filter(e => e.kind === "reset").length, 0);
});

test("continuous RO coalesces latest positive fractional rect without exposing cleared buffers", t => {
  const h = fixture(t), before = snapshot(h), mark = h.ledger.length;
  h.size.width = 700; h.size.height = 400; h.ro.trigger();
  h.size.width = 801; h.size.height = 451; h.ro.trigger();
  h.size.width = 640.25; h.size.height = 360.25; h.ro.trigger();
  retained(h, before);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  assert.equal(h.win.queued(), 1);
  h.win.run();
  atomic(h, mark, "A", [1281, 721], { left: 0, top: 0, width: 576.25, height: 340.25 });
  assert.deepEqual(h.counts, { gpu: 2, annotation: 2, interaction: 2 });
  assert.deepEqual(h.canvases.map(c => [c.style.width, c.style.height]), Array(3).fill(["640.25px", "360.25px"]));
  const rendered = h.ledger.filter(e => e.kind === "rendered").at(-1);
  assert.equal(rendered.surfaces, ChartSurfaceDirty.All);
  assert.equal(rendered.changes, ChartChange.Layout);
  assert.equal(rendered.frame, h.ledger.at(-1).frame);
});

test("DPR notifications coalesce and commit latest DPR transforms with all three paints", t => {
  const h = fixture(t), before = snapshot(h), mark = h.ledger.length;
  h.win.devicePixelRatio = 1.5; h.win.media();
  h.win.devicePixelRatio = 1.25; h.win.media();
  retained(h, before);
  assert.equal(h.win.queued(), 1);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  h.win.run();
  atomic(h, mark, "A", [800, 450], { left: 0, top: 0, width: 576, height: 340 });
  assert.deepEqual(h.ledger.slice(mark).filter(e => e.kind === "transform").map(e => e.values),
    [[1.25, 0, 0, 1.25, 0, 0], [1.25, 0, 0, 1.25, 0, 0]]);
  assert.equal(h.win.listeners(), 1, "DPR watcher replacement must not leak listeners");
});

test("resized capture reads current GPU frame after paint and never after another bitmap reset", async t => {
  const h = fixture(t), before = snapshot(h), mark = h.ledger.length;
  h.size.width = 650; h.size.height = 370; h.ro.trigger();
  const capture = h.session.captureCompositePng();
  // Register rejection handling even if an earlier invariant fails and cleanup rejects capture.
  void capture.catch(() => {});
  retained(h, before);
  assert.equal(h.win.queued(), 1);
  h.win.run();
  // Encoding is allowed after the drawing turn; only commit/draw/readPixels are atomic.
  const events = h.ledger.slice(mark);
  const read = events.find(e => e.kind === "readPixels");
  const gpu = events.find(e => e.kind === "paint" && e.surface === "gpu");
  assert.ok(read && gpu);
  assert.equal(read.frame, gpu.frame);
  assert.ok(read.timestamp > gpu.timestamp);
  assert.deepEqual([read.width, read.height], [1300, 740]);
  assert.ok(events.filter(e => e.kind === "reset").every(e => e.timestamp < gpu.timestamp));
  assert.deepEqual(events.filter(e => e.kind === "paint").map(e => e.frame), [gpu.frame, gpu.frame, gpu.frame]);
  assert.ok(h.canvases.every(c => c.painted));
  const encoded = await capture;
  assert.deepEqual([encoded.width, encoded.height], [1300, 740]);
  assert.equal(encoded.blob.type, "image/png");
  assert.equal(h.win.queued(), 0);
});

test("hidden zero measurements and deactivated notifications retain valid painted size without leaks", t => {
  const h = fixture(t), before = snapshot(h);
  h.size.width = 0; h.size.height = 0; h.ro.trigger();
  retained(h, before);
  assert.equal(h.win.queued(), 0);
  h.session.invalidate(ChartChange.Interaction);
  assert.equal(h.win.queued(), 1);
  h.session.deactivate();
  assert.equal(h.win.queued(), 0);
  h.size.width = 800; h.size.height = 450; h.ro.trigger();
  h.win.devicePixelRatio = 1.5; h.win.media();
  retained(h, before);
  assert.equal(h.win.queued(), 0);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  h.session.destroy();
  assert.equal(h.win.listeners(), 0);
  assert.ok(h.canvases.every(c => c.listeners() === 0));
});

test("context loss cancels pending resize and capture without clearing retained bitmaps", async t => {
  const h = fixture(t), before = snapshot(h);
  const capture = h.session.captureCompositePng();
  const rejected = assert.rejects(capture, e => e?.code === "CAPTURE_FAILED");
  h.size.width = 700; h.size.height = 400; h.ro.trigger();
  assert.equal(h.win.queued(), 1);
  h.canvases[0].dispatch("webglcontextlost");
  await rejected;
  assert.equal(h.win.queued(), 0);
  h.size.width = 800; h.size.height = 450; h.ro.trigger();
  retained(h, before);
  if (h.win.queued()) h.win.run();
  retained(h, before);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  h.session.destroy();
  assert.equal(h.win.queued(), 0);
  assert.equal(h.win.listeners(), 0);
});

test("adoption cancels old-owner resize RAF and retains bitmaps until new-owner atomic commit", t => {
  const h = fixture(t), before = snapshot(h), mark = h.ledger.length;
  h.session.invalidate(ChartChange.Interaction);
  assert.equal(h.win.queued(), 1);
  const newWin = h.owner("B", 1.5), newDoc = { ...h.doc, defaultView: newWin };
  let unrelated = 0;
  newWin.requestAnimationFrame(() => unrelated++);
  h.session.updateContainer(h.container(newDoc));
  assert.equal(h.win.queued(), 0, "old owner's actual callback must be cancelled");
  assert.equal(h.win.listeners(), 0);
  assert.equal(h.ro.observed, false);
  assert.equal(newWin.queued(), 2, "one unrelated control plus exactly one session callback");
  retained(h, before);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  newWin.run();
  assert.equal(unrelated, 1);
  retained(h, before);
  const sessionMark = h.ledger.length;
  newWin.run();
  atomic(h, sessionMark, "B", [960, 540], { left: 0, top: 0, width: 576, height: 340 });
  assert.ok(h.ledger.slice(mark).some(e => e.kind === "cancel" && e.owner === "A"));
  assert.equal(newWin.queued(), 0);
  h.session.destroy();
  assert.equal(newWin.listeners(), 0);
  assert.equal(h.observers.at(-1).observed, false);
  assert.ok(h.canvases.every(c => c.listeners() === 0));
});

for (const boundary of ["transform", "resize"]) {
  test("resize " + boundary + " exception propagates and releases frame while retaining all cleared paint debt", t => {
    // Given healthy initial bitmaps, then a one-shot failure inside a resize commit.
    const hooks = {};
    const h = fixture(t, hooks), error = new Error("one-shot " + boundary);
    let armed = true;
    hooks[boundary] = () => { if (armed) { armed = false; throw error; } };
    h.size.width = 700; h.size.height = 400; h.ro.trigger();
    assert.equal(h.win.queued(), 1);
    const mark = h.ledger.length;
    assert.throws(() => h.win.run(), e => e === error, "the original callback error must escape unchanged");
    const cleared = new Set(h.ledger.slice(mark).filter(e => e.kind === "reset").map(e => e.surface));
    assert.deepEqual([...cleared], ["gpu", "annotation", "interaction"]);
    assert.equal(h.win.queued(), 0, "failure must not manufacture an automatic retry loop");
    // When only Interaction is explicitly invalidated, all physically cleared surfaces still owe paint.
    h.session.invalidate(ChartChange.Interaction);
    assert.equal(h.win.queued(), 1, "the finished failed RAF ID must not coalesce away a future invalidation");
    const recovery = h.ledger.length;
    h.win.run();
    assert.deepEqual(h.ledger.slice(recovery).filter(e => e.kind === "paint").map(e => e.surface),
      ["gpu", "annotation", "interaction"], "all cleared surfaces must repay paint debt");
    assert.ok(h.canvases.every(c => c.painted));
    const events = h.ledger.slice(recovery), enter = events.find(e => e.kind === "enter");
    assert.ok(enter && enter.frame.startsWith("A:"), "recovery must execute on the actual owner RAF");
    assert.deepEqual(h.canvases.map(c => [c.width, c.height]),
      [[1400, 800], [1400, 800], [1400, 800]]);
    assert.deepEqual(h.view.area, { left: 0, top: 0, width: 636, height: 380 });
    assert.equal(events.filter(e => e.kind === "reset").length, 0,
      "unchanged physical dimensions must not reset bitmaps again during recovery");
    const paints = events.filter(e => e.kind === "paint");
    const transforms = events.filter(e => e.kind === "transform");
    assert.deepEqual(transforms.map(e => [e.surface, e.values]),
      [["annotation", [2, 0, 0, 2, 0, 0]], ["interaction", [2, 0, 0, 2, 0, 0]]],
      "both DPR transforms must be restored on the healthy retry");
    const adaptations = events.filter(e => e.kind === "adapt");
    assert.equal(adaptations.length, 1, "the incomplete resize callback must complete on the healthy retry");
    assert.deepEqual([adaptations[0].width, adaptations[0].height, adaptations[0].dpr], [700, 400, 2]);
    assert.ok([...transforms, ...adaptations].every(e => e.timestamp < paints[0].timestamp),
      "both transforms and complete healthy adaptation must precede every paint");
    for (const e of [...transforms, ...adaptations, ...paints]) {
      assert.equal(e.frame, enter.frame, "recovery work must complete within the same owned callback");
    }
    for (const e of paints) {
      assert.deepEqual([e.width, e.height], [1400, 800]);
      assert.deepEqual(e.area, { left: 0, top: 0, width: 636, height: 380 });
      assert.equal(e.colWidth, 11, "recovery preserves caller-owned horizontal zoom");
      assert.equal(e.offsetX, 37, "recovery preserves caller-owned horizontal position");
    }
    assert.equal(h.ledger.at(-1).kind, "leave");
    assert.equal(h.ledger.at(-1).frame, enter.frame);
    assert.equal(h.win.queued(), 0);
  });
}

test("reentrant resize notification retains first commit and schedules exactly one latest-target owner frame", t => {
  const hooks = {}, h = fixture(t, hooks);
  let first = true;
  hooks.resize = () => {
    if (!first) return;
    first = false;
    const committed = snapshot(h);
    h.size.width = 800; h.size.height = 450; h.ro.trigger();
    retained(h, committed);
    assert.deepEqual(h.view.area, { left: 0, top: 0, width: 636, height: 380 },
      "notification must not eagerly adapt the second target");
  };
  // Given a pending first target; When its public resize callback notifies a newer target.
  h.size.width = 700; h.size.height = 400; h.ro.trigger();
  h.win.run();
  assert.deepEqual(h.canvases.map(c => [c.width, c.height]), Array(3).fill([1400, 800]));
  assert.ok(h.canvases.every(c => c.painted));
  assert.equal(h.win.queued(), 1, "reentrant resize intent must survive consumed draw dirtiness");
  const mark = h.ledger.length;
  h.win.run();
  // Then exactly one subsequent owner callback commits and repaints the latest target.
  atomic(h, mark, "A", [1600, 900], { left: 0, top: 0, width: 736, height: 430 });
});

test("same-size same-DPR adoption transfers pending repaint and capture without cancelling colliding foreign RAF", async t => {
  const h = fixture(t), before = snapshot(h);
  h.session.invalidate(ChartChange.Interaction);
  const capture = h.session.captureCompositePng();
  void capture.catch(() => {});
  assert.equal(h.win.queued(), 1, "old owner must have actual pending session work");
  const newWin = h.owner("B", 2), newDoc = { ...h.doc, defaultView: newWin };
  let unrelated = 0;
  newWin.requestAnimationFrame(() => unrelated++);
  const collision = newWin.requestAnimationFrame(() => unrelated++);
  assert.equal(collision, 2, "foreign owner ID collides with the old pending session ID");
  const mark = h.ledger.length;
  h.session.updateContainer(h.container(newDoc));
  retained(h, before);
  assert.equal(h.win.queued(), 0);
  assert.deepEqual(h.ledger.slice(mark).filter(e => e.kind === "cancel").map(e => [e.owner, e.id]),
    [["A", 2]], "only the actual old-owner callback may be cancelled");
  assert.equal(newWin.queued(), 3, "two foreign controls plus exactly one transferred session frame");
  newWin.run(); newWin.run();
  assert.equal(unrelated, 2);
  retained(h, before);
  const commit = h.ledger.length;
  newWin.run();
  const events = h.ledger.slice(commit), read = events.find(e => e.kind === "readPixels");
  assert.ok(read && read.frame.startsWith("B:"));
  assert.deepEqual([read.width, read.height], [1280, 720]);
  assert.ok(events.some(e => e.kind === "paint" && e.surface === "gpu" && e.frame === read.frame &&
    e.timestamp < read.timestamp), "capture must read the new owner's current GPU draw");
  assert.ok(events.some(e => e.kind === "paint" && e.surface === "interaction"));
  assert.ok(h.canvases.every(c => c.painted));
  assert.equal(events.filter(e => e.kind === "reset").length, 0);
  const encoded = await capture;
  assert.deepEqual([encoded.width, encoded.height], [1280, 720]);
  assert.equal(newWin.queued(), 0);
});

test("same-size owner adoption creates no frame when healthy idle or inactive", t => {
  for (const inactive of [false, true]) {
    const h = fixture(t), before = snapshot(h);
    if (inactive) h.session.deactivate();
    const newWin = h.owner("B", 2), newDoc = { ...h.doc, defaultView: newWin };
    h.session.updateContainer(h.container(newDoc));
    retained(h, before);
    assert.equal(h.win.queued(), 0);
    assert.equal(newWin.queued(), 0, "owner notification alone must not invent paint debt");
    assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  }
});

test("positive RO becoming zero before commit keeps last applied bitmaps and recovers on visible notification", t => {
  const h = fixture(t), before = snapshot(h);
  h.size.width = 700; h.size.height = 400; h.ro.trigger();
  assert.equal(h.win.queued(), 1);
  h.size.width = 0; h.size.height = 0; h.ro.trigger();
  retained(h, before);
  assert.equal(h.win.queued(), 1);
  h.win.run();
  retained(h, before);
  assert.equal(h.win.queued(), 0, "hidden measurement must not cause a busy loop");
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  const mark = h.ledger.length;
  h.size.width = 800; h.size.height = 450; h.ro.trigger();
  retained(h, before);
  assert.equal(h.win.queued(), 1);
  h.win.run();
  atomic(h, mark, "A", [1600, 900], { left: 0, top: 0, width: 736, height: 430 });
});


test("resize callback All invalidation is consumed by the same atomic owner frame without an idle successor", t => {
  const hooks = {}, h = fixture(t, hooks), before = snapshot(h);
  assert.equal(h.win.queued(), 0, "warm fixture must be idle before enabling resize invalidation");
  let resizeCalls = 0;
  // Mirrors the synchronous onResize -> pending nPOC application -> invalidateAll path.
  hooks.resize = () => {
    resizeCalls++;
    if (resizeCalls === 1) h.session.invalidate(ChartChange.All);
  };
  const mark = h.ledger.length;
  h.size.width = 640.25; h.size.height = 360.25; h.ro.trigger();
  retained(h, before);
  assert.deepEqual(h.counts, { gpu: 1, annotation: 1, interaction: 1 });
  assert.equal(resizeCalls, 0, "notification must not eagerly invoke resize adaptation");
  assert.equal(h.win.queued(), 1, "exactly one owner callback must commit the measured resize");
  h.win.run();
  assert.equal(resizeCalls, 1, "the resize callback invalidates All exactly once");
  assert.deepEqual(h.counts, { gpu: 2, annotation: 2, interaction: 2 });
  const events = h.ledger.slice(mark), enter = events[0], leave = events.at(-1);
  assert.equal(enter.kind, "enter");
  assert.ok(enter.frame.startsWith("A:"), "commit must use the current owner");
  assert.deepEqual(events.map(e => e.kind), [
    "enter", "reset", "reset", "reset", "reset", "reset", "reset",
    "transform", "transform", "adapt", "paint", "paint", "paint", "rendered", "leave",
  ], "the full native ledger must complete reset/transform/layout/paint before returning");
  assert.ok(events.every(e => e.frame === enter.frame), "all effects belong to the single owner callback");
  assert.deepEqual(events.filter(e => e.kind === "reset").map(e => [e.surface, e.axis, e.value]), [
    ["gpu", "width", 1281], ["gpu", "height", 721],
    ["annotation", "width", 1281], ["annotation", "height", 721],
    ["interaction", "width", 1281], ["interaction", "height", 721],
  ]);
  assert.deepEqual(events.filter(e => e.kind === "transform").map(e => [e.surface, e.values]), [
    ["annotation", [2, 0, 0, 2, 0, 0]], ["interaction", [2, 0, 0, 2, 0, 0]],
  ]);
  const adapt = events.find(e => e.kind === "adapt");
  assert.deepEqual([adapt.width, adapt.height, adapt.dpr], [640.25, 360.25, 2]);
  const paints = events.filter(e => e.kind === "paint");
  assert.deepEqual(paints.map(e => e.surface), ["gpu", "annotation", "interaction"]);
  for (const e of paints) {
    assert.deepEqual([e.width, e.height], [1281, 721]);
    assert.deepEqual(e.area, { left: 0, top: 0, width: 576.25, height: 340.25 });
    assert.equal(e.colWidth, 11, "manual spacing stays caller-owned");
    assert.equal(e.offsetX, 37, "manual offset stays caller-owned");
    assert.ok(adapt.timestamp < e.timestamp && e.timestamp < leave.timestamp);
  }
  assert.deepEqual(h.canvases.map(c => [c.style.width, c.style.height]), Array(3).fill(["640.25px", "360.25px"]));
  assert.ok(h.canvases.every(c => c.painted), "all three bitmaps are positive before the queue oracle");
  const rendered = events.find(e => e.kind === "rendered");
  assert.equal(rendered.surfaces, ChartSurfaceDirty.All);
  assert.equal(rendered.changes, ChartChange.All | ChartChange.Layout);
  assert.equal(h.win.queued(), 0, "resize callback invalidation already painted in this frame must not leave an idle successor");
});
