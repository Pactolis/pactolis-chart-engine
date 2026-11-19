import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uiColor } from "../dist/core/ui/seriesPalette.js";
import {
  acquireInteractionCanvasFocusStyle,
  CHART_CANVAS_ARIA_KEYSHORTCUTS,
  CHART_CANVAS_SHORTCUTS,
  CHART_INTERACTION_CANVAS_CLASS,
  CHART_INTERACTION_CANVAS_STYLE_ID,
  CHART_INTERACTION_FOCUS_STYLE,
  configureInteractionCanvasAttributes,
  formatChartCanvasAriaLabel,
  matchesChartCanvasShortcut,
  syncInteractionCanvasAriaLabel,
} from "../dist/features/chart/chartCanvasAccessibility.js";
import { ChartSyncController } from "../dist/features/chart/ChartSyncController.js";

function makeFakeCanvas() {
  const attrs = new Map();
  const classes = new Set();
  const calls = [];
  return {
    attrs,
    classes,
    calls,
    dataset: {},
    tabIndex: -1,
    className: "",
    classList: {
      add: (name) => {
        classes.add(name);
      },
      contains: (name) => classes.has(name),
    },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => {
      attrs.set(name, String(value));
      calls.push({ op: "setAttribute", name, value: String(value) });
    },
  };
}

function makeFakeDocument() {
  const stylesById = new Map();
  const headChildren = [];
  const createNode = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      id: "",
      textContent: "",
      isConnected: false,
      parentNode: null,
      remove() {
        if (this.parentNode) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children.splice(idx, 1);
          this.parentNode = null;
        }
        if (this.id && stylesById.get(this.id) === this) {
          stylesById.delete(this.id);
        }
        this.isConnected = false;
      },
    };
    return node;
  };
  const head = {
    children: headChildren,
    appendChild(node) {
      node.parentNode = head;
      node.isConnected = true;
      if (node.id) stylesById.set(node.id, node);
      headChildren.push(node);
      return node;
    },
  };
  return {
    head,
    headChildren,
    createElement: (tag) => createNode(tag),
    getElementById: (id) => stylesById.get(id) ?? null,
  };
}

test("interactionCanvas accessibility configures initial attributes and skips redundant aria-label writes", () => {
  const canvas = makeFakeCanvas();
  configureInteractionCanvasAttributes(canvas, { market: "BINANCE_FUTURES:btcusdt", timeframe: "15m" });

  assert.equal(canvas.dataset.chartSurface, "interaction");
  assert.equal(canvas.classList.contains(CHART_INTERACTION_CANVAS_CLASS), true);
  assert.equal(canvas.tabIndex, 0);
  assert.equal(canvas.getAttribute("role"), "application");
  assert.equal(canvas.getAttribute("aria-keyshortcuts"), CHART_CANVAS_ARIA_KEYSHORTCUTS);
  const tokens = CHART_CANVAS_ARIA_KEYSHORTCUTS.split(" ");
  assert.equal(new Set(tokens).size, tokens.length, "aria-keyshortcuts must not contain duplicates");
  for (const expected of [
    "?",
    "ContextMenu",
    "Shift+F10",
    "Delete",
    "Backspace",
    "Control+A",
    "Meta+A",
    "Control+D",
    "Meta+D",
    "Control+C",
    "Meta+C",
    "Control+V",
    "Meta+V",
    "Control+Z",
    "Meta+Z",
    "Control+Y",
    "Meta+Y",
    "Control+Shift+Z",
    "Meta+Shift+Z",
    "Escape",
    "X",
  ]) {
    assert.ok(tokens.includes(expected), `missing expected aria-keyshortcuts token: ${expected}`);
  }
  assert.ok(CHART_CANVAS_SHORTCUTS.length >= 11);
  assert.equal(matchesChartCanvasShortcut("drawing-redo", { key: "Z", ctrlKey: true, shiftKey: true }), true);
  assert.equal(matchesChartCanvasShortcut("drawing-undo", { key: "Z", ctrlKey: true, shiftKey: true }), false);
  assert.equal(matchesChartCanvasShortcut("reset-time-scale", { key: "x" }), true);
  assert.equal(matchesChartCanvasShortcut("reset-time-scale", { key: "x", ctrlKey: true }), false);
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:btcusdt 15m");
  assert.equal(formatChartCanvasAriaLabel("BINANCE_FUTURES:ethusdt", "1h"), "BINANCE_FUTURES:ethusdt 1h");

  canvas.calls.length = 0;
  syncInteractionCanvasAriaLabel(canvas, { market: "BINANCE_FUTURES:btcusdt", timeframe: "15m" });
  assert.equal(canvas.calls.length, 0, "no redundant setAttribute when market/timeframe are unchanged");

  syncInteractionCanvasAriaLabel(canvas, { market: "BINANCE_FUTURES:ethusdt", timeframe: "15m" });
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:ethusdt 15m");
  syncInteractionCanvasAriaLabel(canvas, { market: "BINANCE_FUTURES:ethusdt", timeframe: "4h" });
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:ethusdt 4h");
});

test("ChartSyncController updateState, persistState restore and replacement canvas keep aria-label synced", () => {
  let state = {
    type: "chart",
    market: "BINANCE_FUTURES:btcusdt",
    timeframe: "1m",
    scaleMode: "linear",
    linkGroup: "red",
  };
  let canvas = makeFakeCanvas();
  configureInteractionCanvasAttributes(canvas, state);

  const syncController = new ChartSyncController({
    pipeline: { series: { length: 0 } },
    session: { invalidate: () => undefined },
    view: { area: { left: 0, top: 0, width: 800, height: 400 } },
    timeViewport: {},
    isDisposed: () => false,
    getState: () => ({ ...state }),
    updateState: (next) => {
      state = { ...next };
      syncInteractionCanvasAriaLabel(canvas, state);
    },
    persistState: (next) => {
      state = { ...next };
      syncInteractionCanvasAriaLabel(canvas, state);
    },
    autoFit: () => undefined,
    applyExternalReplay: () => undefined,
    subscribeReplayState: () => () => undefined,
  });

  // External market & timeframe switches update aria-label immediately
  syncController.applyExternalMarket("BINANCE_FUTURES:solusdt");
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:solusdt 1m");

  syncController.applyExternalTimeframe("4h");
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:solusdt 4h");

  // Controller persist/restore flow keeps aria-label synced
  syncController.setLinkGroup("blue");
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:solusdt 4h");
  syncController.host.persistState({ ...state, market: "BINANCE_FUTURES:avaxusdt", timeframe: "1d" });
  assert.equal(canvas.getAttribute("aria-label"), "BINANCE_FUTURES:avaxusdt 1d");

  // Container remount / canvas replacement configures new canvas with active state's aria-label
  const previousCanvas = canvas;
  const replacementCanvas = makeFakeCanvas();
  canvas = replacementCanvas;
  configureInteractionCanvasAttributes(replacementCanvas, state);
  assert.equal(previousCanvas.getAttribute("aria-label"), "BINANCE_FUTURES:avaxusdt 1d");
  assert.equal(replacementCanvas.getAttribute("aria-label"), "BINANCE_FUTURES:avaxusdt 1d");
  assert.equal(replacementCanvas.tabIndex, 0);
  assert.equal(replacementCanvas.getAttribute("role"), "application");
  assert.equal(replacementCanvas.classList.contains(CHART_INTERACTION_CANVAS_CLASS), true);
});

test("focus-visible style uses host theme token fallback chain, stays idempotent across charts, and cleans up on dispose", () => {
  assert.match(CHART_INTERACTION_FOCUS_STYLE, /\.chart-interaction-canvas:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;\s*outline-width:\s*0;\s*\}/);
  assert.match(
    CHART_INTERACTION_FOCUS_STYLE,
    new RegExp(`\\.chart-interaction-canvas:focus-visible\\s*\\{[^}]*outline:\\s*2px solid var\\(--ui-focus-ring-color,\\s*var\\(--ui-color-info,\\s*${uiColor.info}\\)\\);\\s*outline-offset:\\s*-2px;`),
  );

  const doc = makeFakeDocument();
  const releaseChartA = acquireInteractionCanvasFocusStyle(doc);
  const releaseChartB = acquireInteractionCanvasFocusStyle(doc);

  assert.equal(doc.headChildren.length, 1, "multiple charts share a single style node per document");
  assert.equal(doc.headChildren[0].id, CHART_INTERACTION_CANVAS_STYLE_ID);
  assert.equal(doc.headChildren[0].textContent, CHART_INTERACTION_FOCUS_STYLE);

  // Disposing one chart retains style node for remaining chart
  releaseChartA();
  assert.equal(doc.headChildren.length, 1);
  // Idempotent repeat release must not decrement refcount twice
  releaseChartA();
  assert.equal(doc.headChildren.length, 1);

  // Cross-document migration acquires style in target document and releases old one
  const popoutDoc = makeFakeDocument();
  const releasePopout = acquireInteractionCanvasFocusStyle(popoutDoc);
  assert.equal(popoutDoc.headChildren.length, 1);

  // Final chart disposal on original doc removes engine-owned style element
  releaseChartB();
  assert.equal(doc.headChildren.length, 0);
  assert.equal(popoutDoc.headChildren.length, 1);
  releasePopout();
  assert.equal(popoutDoc.headChildren.length, 0);

  // Preexisting host style element with the same ID must not be removed by engine dispose
  const hostManagedDoc = makeFakeDocument();
  const preexisting = hostManagedDoc.createElement("style");
  preexisting.id = CHART_INTERACTION_CANVAS_STYLE_ID;
  hostManagedDoc.head.appendChild(preexisting);
  const releaseHosted = acquireInteractionCanvasFocusStyle(hostManagedDoc);
  assert.equal(hostManagedDoc.headChildren.length, 1);
  releaseHosted();
  assert.equal(hostManagedDoc.headChildren.length, 1, "preexisting style owned by host stays connected");
});

test("ChartRuntime wires every state update, lifecycle refresh, canvas setup, and disposal through shared accessibility helpers", () => {
  const source = readFileSync(new URL("../src/features/chart/ChartRuntime.ts", import.meta.url), "utf8");
  assert.match(source, /private setPanelState\(next: ChartPanelState\): void[\s\S]*?syncInteractionCanvasAriaLabel\(this\.interactionCanvas, this\.state\)/);
  assert.match(source, /updateState\(next: ChartPanelState\): void[\s\S]*?this\.setPanelState\(constrainedNext\)/);
  assert.match(source, /persistState:\s*\(next\)\s*=>\s*\{[\s\S]*?this\.setPanelState\(\{\s*\.\.\.next\s*\}\)/);
  assert.match(source, /private bindInputController\(\): void[\s\S]*?configureInteractionCanvasAttributes\(this\.interactionCanvas, this\.state\)/);
  assert.match(source, /refreshHostLifecycle\(\): void[\s\S]*?this\.syncFocusStyle\(\)[\s\S]*?this\.bindInputController\(\)/);
  assert.match(source, /dispose\(\): void[\s\S]*?this\.releaseFocusStyle\(\)/);
  assert.match(source, /async function buildChartRuntime[\s\S]*?configureInteractionCanvasAttributes\(interactionCanvas, initialState\)/);
  // Ensure no direct post-constructor this.state mutations bypass setPanelState
  const rawStateWrites = [...source.matchAll(/this\.state\s*=/g)].map((m) => source.slice(Math.max(0, m.index - 80), m.index + 30));
  assert.equal(rawStateWrites.length, 2, "only setPanelState and initial constructor assignment may write this.state directly");

  const inputSource = readFileSync(new URL("../src/features/chart/ChartInputController.ts", import.meta.url), "utf8");
  assert.match(inputSource, /if \(touch\)\s*\{[\s\S]*?\.focus\(\{\s*preventScroll:\s*true,\s*focusVisible:\s*false\s*\}\)/);
});
