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

export interface ChartKeyboardEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export type ChartCanvasShortcutAction =
  | "help"
  | "context-menu"
  | "drawing-delete"
  | "drawing-select-all"
  | "drawing-duplicate"
  | "drawing-copy"
  | "drawing-paste"
  | "drawing-undo"
  | "drawing-redo"
  | "escape"
  | "reset-time-scale";

export interface ChartCanvasShortcutDescriptor {
  readonly action: ChartCanvasShortcutAction;
  readonly ariaShortcuts: readonly string[];
  matches(event: ChartKeyboardEventLike): boolean;
}

const hasCommandModifier = (e: ChartKeyboardEventLike): boolean => Boolean(e.ctrlKey || e.metaKey);

/**
 * Single canonical shortcut table shared by `aria-keyshortcuts` on the
 * interactive canvas and `ChartInputController`'s key handlers.
 */
export const CHART_CANVAS_SHORTCUTS: readonly ChartCanvasShortcutDescriptor[] = [
  {
    action: "help",
    ariaShortcuts: ["?"],
    matches: (e) => e.key === "?" || (Boolean(e.shiftKey) && e.key === "/"),
  },
  {
    action: "context-menu",
    ariaShortcuts: ["ContextMenu", "Shift+F10"],
    matches: (e) => e.key === "ContextMenu" || (Boolean(e.shiftKey) && e.key === "F10"),
  },
  {
    action: "drawing-delete",
    ariaShortcuts: ["Delete", "Backspace"],
    matches: (e) => e.key === "Delete" || e.key === "Backspace",
  },
  {
    action: "drawing-select-all",
    ariaShortcuts: ["Control+A", "Meta+A"],
    matches: (e) => hasCommandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "a",
  },
  {
    action: "drawing-duplicate",
    ariaShortcuts: ["Control+D", "Meta+D"],
    matches: (e) => hasCommandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "d",
  },
  {
    action: "drawing-copy",
    ariaShortcuts: ["Control+C", "Meta+C"],
    matches: (e) => hasCommandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "c",
  },
  {
    action: "drawing-paste",
    ariaShortcuts: ["Control+V", "Meta+V"],
    matches: (e) => hasCommandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "v",
  },
  {
    action: "drawing-undo",
    ariaShortcuts: ["Control+Z", "Meta+Z"],
    matches: (e) => hasCommandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "z",
  },
  {
    action: "drawing-redo",
    ariaShortcuts: ["Control+Y", "Meta+Y", "Control+Shift+Z", "Meta+Shift+Z"],
    matches: (e) => hasCommandModifier(e) && (e.key.toLowerCase() === "y" || (Boolean(e.shiftKey) && e.key.toLowerCase() === "z")),
  },
  {
    action: "escape",
    ariaShortcuts: ["Escape"],
    matches: (e) => e.key === "Escape",
  },
  {
    action: "reset-time-scale",
    ariaShortcuts: ["X"],
    matches: (e) => e.key.toLowerCase() === "x" && !e.ctrlKey && !e.metaKey && !e.altKey,
  },
];

const SHORTCUT_BY_ACTION = new Map<ChartCanvasShortcutAction, ChartCanvasShortcutDescriptor>(
  CHART_CANVAS_SHORTCUTS.map((descriptor) => [descriptor.action, descriptor]),
);

export const CHART_CANVAS_ARIA_KEYSHORTCUTS = CHART_CANVAS_SHORTCUTS
  .flatMap((descriptor) => descriptor.ariaShortcuts)
  .join(" ");

export function matchesChartCanvasShortcut(
  action: ChartCanvasShortcutAction,
  event: ChartKeyboardEventLike,
): boolean {
  return SHORTCUT_BY_ACTION.get(action)?.matches(event) ?? false;
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
  canvas.setAttribute("aria-keyshortcuts", CHART_CANVAS_ARIA_KEYSHORTCUTS);
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
