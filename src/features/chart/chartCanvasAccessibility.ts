import type { ChartPanelState } from "../../core/chartPanelState.js";
import { uiColor } from "../../core/ui/seriesPalette.js";

export const CHART_INTERACTION_CANVAS_CLASS = "chart-interaction-canvas";
export const CHART_INTERACTION_CANVAS_STYLE_ID = "pactolis-chart-interaction-canvas-style";

/**
 * Keyboard focus ring for the interactive chart canvas.
 *
 * Uses the host theme tokens (`--ui-focus-ring-color`, then `--ui-color-info`)
 * with the engine's canonical info accent fallback so focus remains clearly
 * visible even when hosted outside the main application shell, while keeping
 * pointer clicks free of focus outlines.
 */
export const CHART_INTERACTION_FOCUS_STYLE = [
  `.${CHART_INTERACTION_CANVAS_CLASS}:focus:not(:focus-visible) { outline: none; outline-width: 0; }`,
  `.${CHART_INTERACTION_CANVAS_CLASS}:focus-visible { outline: 2px solid var(--ui-focus-ring-color, var(--ui-color-info, ${uiColor.info})); outline-offset: -2px; }`,
].join("\n");

interface FocusStyleRegistration {
  readonly style: HTMLStyleElement;
  readonly owned: boolean;
  refs: number;
}

const documentFocusStyleRefs = new WeakMap<Document, FocusStyleRegistration>();

/** Format the screen-reader label for an interactive chart canvas. */
export function formatChartCanvasAriaLabel(market: string, timeframe: string): string {
  return `${market} ${timeframe}`;
}

/** Sync `aria-label` on `canvas` to the active market and timeframe. */
export function syncInteractionCanvasAriaLabel(
  canvas: HTMLCanvasElement,
  state: Pick<ChartPanelState, "market" | "timeframe">,
): string {
  const nextLabel = formatChartCanvasAriaLabel(state.market, state.timeframe);
  if (canvas.getAttribute("aria-label") !== nextLabel) {
    canvas.setAttribute("aria-label", nextLabel);
  }
  return nextLabel;
}

/** Apply accessibility attributes, class membership, and initial `aria-label` to `canvas`. */
export function configureInteractionCanvasAttributes(
  canvas: HTMLCanvasElement,
  state: Pick<ChartPanelState, "market" | "timeframe">,
): void {
  canvas.dataset.chartSurface = "interaction";
  if (canvas.classList && typeof canvas.classList.add === "function") {
    canvas.classList.add(CHART_INTERACTION_CANVAS_CLASS);
  } else {
    canvas.className = CHART_INTERACTION_CANVAS_CLASS;
  }
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-keyshortcuts", "? ContextMenu Shift+F10");
  syncInteractionCanvasAriaLabel(canvas, state);
}

/**
 * Inject the `:focus-visible` style sheet into `doc` once for all chart
 * instances on that document, returning an idempotent refcount-based releaser.
 */
export function acquireInteractionCanvasFocusStyle(
  doc: Document | null | undefined,
  fallbackContainer?: HTMLElement | null,
): () => void {
  if (!doc || typeof doc.createElement !== "function") {
    return () => undefined;
  }

  let registration = documentFocusStyleRefs.get(doc);
  if (!registration) {
    const existing = typeof doc.getElementById === "function"
      ? (doc.getElementById(CHART_INTERACTION_CANVAS_STYLE_ID) as HTMLStyleElement | null)
      : null;
    if (existing) {
      registration = { style: existing, owned: false, refs: 0 };
      documentFocusStyleRefs.set(doc, registration);
    } else {
      const target = doc.head ?? doc.documentElement ?? fallbackContainer ?? null;
      if (!target || typeof target.appendChild !== "function") {
        return () => undefined;
      }
      const style = doc.createElement("style");
      style.id = CHART_INTERACTION_CANVAS_STYLE_ID;
      style.textContent = CHART_INTERACTION_FOCUS_STYLE;
      target.appendChild(style);
      registration = { style, owned: true, refs: 0 };
      documentFocusStyleRefs.set(doc, registration);
    }
  } else if (registration.owned && registration.style.isConnected === false) {
    const target = doc.head ?? doc.documentElement ?? fallbackContainer ?? null;
    if (target && typeof target.appendChild === "function") {
      target.appendChild(registration.style);
    }
  }

  registration.refs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = documentFocusStyleRefs.get(doc);
    if (!current || current !== registration) return;
    current.refs -= 1;
    if (current.refs <= 0) {
      documentFocusStyleRefs.delete(doc);
      if (current.owned && typeof current.style.remove === "function") {
        current.style.remove();
      }
    }
  };
}
