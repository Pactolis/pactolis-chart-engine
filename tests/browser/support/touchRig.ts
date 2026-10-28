import type { Page } from "@playwright/test";

/**
 * A ChartInputController on a bare canvas with a recording host, for specs that drive it with
 * synthetic pointer events. The rig is installed once per page as `window.__touchRig(options)`;
 * a spec calls it inside `page.evaluate`, dispatches events and returns plain data.
 *
 * Geometry: a 400x300 canvas, plot 350x250 at the origin, price axis 50 wide, time axis 50 tall.
 */
export interface TouchRigOptions {
  activeTool?: string | null;
  hasDraft?: boolean;
  /** What DrawingManager.peekAt answers for a touch. */
  peek?: { id: string; selected: boolean } | null;
  /** Whether DrawingManager.pointerDown takes the press, and whether that makes it a drag. */
  pointerDownTakesPress?: boolean;
  dragActive?: boolean;
  selectedIds?: string[];
  autoScale?: boolean;
  coarse?: boolean;
  /** Screen rect of the overlay's corner menu button, if one is drawn. */
  menuButton?: { x: number; y: number; w: number; h: number } | null;
  /** Answer of Overlay.getPriceScaleControlAt. */
  priceControl?: (x: number, y: number) => "autoScale" | "logarithmic" | null;
}

export interface TouchRig {
  canvas: HTMLCanvasElement;
  view: { priceTop: number };
  crosshair: { x: number; y: number; visible: boolean; touch?: boolean };
  log: string[];
  contextMenus: Array<{ target: string; x: number; y: number; clientX: number; clientY: number; drawingSelectionCount?: number }>;
  fire: (type: string, pointerId: number, x: number, y: number, pointerType?: string) => PointerEvent;
  wait: (ms: number) => Promise<void>;
  dispose: () => void;
}

export async function installTouchRig(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { ChartInputController } = await import("/src/features/chart/ChartInputController.ts");

    (window as unknown as { __touchRig: (options?: TouchRigOptions) => TouchRig & { controller: unknown } }).__touchRig = (options = {}) => {
      const captured = new Set<number>();
      const log: string[] = [];
      const round = (value: number): number => Math.round(value * 100) / 100;

      const canvas = document.createElement("canvas");
      canvas.className = "chart-interaction-canvas";
      canvas.tabIndex = 0;
      document.body.appendChild(canvas);
      Object.defineProperties(canvas, {
        setPointerCapture: { value: (id: number) => { captured.add(id); } },
        releasePointerCapture: { value: (id: number) => { captured.delete(id); } },
        hasPointerCapture: { value: (id: number) => captured.has(id) },
      });
      canvas.getBoundingClientRect = () => ({
        x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300,
        toJSON: () => ({}),
      });
      // The controller asks the owner window; a rig on a desktop browser pretends to be a phone on request.
      if (options.coarse) {
        const win = canvas.ownerDocument.defaultView as Window;
        const matchMedia = win.matchMedia.bind(win);
        win.matchMedia = ((query: string) => (query === "(pointer: coarse)"
          ? ({ matches: true, media: query } as MediaQueryList)
          : matchMedia(query))) as typeof win.matchMedia;
      }

      const crosshair: TouchRig["crosshair"] = { x: 0, y: 0, visible: false };
      const contextMenus: TouchRig["contextMenus"] = [];
      canvas.addEventListener("chartcontextmenu", (event) => {
        contextMenus.push((event as CustomEvent).detail);
      });

      const drawings = {
        activeTool: options.activeTool ?? null,
        setMarket: () => undefined,
        hasDraft: () => options.hasDraft ?? false,
        peekAt: (_point: unknown, _screen: unknown, o?: { touch?: boolean }) => {
          log.push(`peek touch=${o?.touch === true}`);
          return options.peek ?? null;
        },
        isPointerDragActive: () => options.dragActive ?? false,
        pointerDown: (point: { time: number }, _screen: unknown, o?: { touch?: boolean }) => {
          log.push(`down ${round(point.time)} touch=${o?.touch === true}`);
          return options.pointerDownTakesPress ?? false;
        },
        pointerMove: (point: { time: number }) => { log.push(`move ${round(point.time)}`); return true; },
        pointerUp: () => { log.push("up"); return true; },
        getSelectedIds: () => options.selectedIds ?? [],
        hitTestAt: () => null,
        cancelDraft: () => undefined,
      };

      let autoScale = options.autoScale ?? true;
      const host = {
        svc: { getAnalysisContext: () => ({ drawings }) },
        view: {
          area: { left: 0, top: 0, width: 350, height: 250 }, priceAxisW: 50, subPanesH: 0,
          chartLayoutOptions: { timeAxisHeight: 50 },
          priceTop: 0, pricePerPx: 1,
          isPriceAutoScale: () => autoScale,
          setPriceAutoScale: (next: boolean) => { autoScale = next; },
          indexOfX: () => 0,
          priceOfY: () => 100,
          panX: (dx: number) => log.push(`panX ${round(dx)}`),
          startPriceAxisScale: (y: number) => log.push(`price start ${round(y)}`),
          scalePriceAxisTo: (y: number) => log.push(`price scale ${round(y)}`),
          endPriceAxisScale: () => log.push("price end"),
        },
        session: { invalidate: () => undefined },
        pipeline: { series: { length: 10 } },
        overlay: {
          getIndicatorAxisPaneAt: () => null,
          getIndicatorPaneAt: () => null,
          getIndicatorScaleControlAt: () => null,
          getPriceScaleControlAt: (x: number, y: number) => options.priceControl?.(x, y) ?? null,
          getMenuButtonAt: (x: number, y: number) => {
            const b = options.menuButton;
            return b ? x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4 : false;
          },
          getMenuButtonRect: () => options.menuButton ?? null,
          getTpoProfileAt: () => null,
        },
        timeViewport: {
          beginPlotPan: () => log.push("begin"),
          dragPlotPanTo: (dx: number) => log.push(`drag ${round(dx)}`),
          endPlotPan: () => log.push("end"),
          beginTimeAxisScale: (x: number) => log.push(`time start ${round(x)}`),
          dragTimeAxisScaleTo: (x: number) => log.push(`time scale ${round(x)}`),
          endTimeAxisScale: () => log.push("time end"),
          applyWheelZoom: (factor: number, anchorX: number, total: number) => log.push(`zoom ${round(factor)} @${round(anchorX)} of ${total}`),
        },
        state: { market: "BTCUSDT", timeframe: "15m" },
        panelId: "touch-rig",
        applyingExternal: false,
        isReplaySelecting: () => false,
        screenToDrawingPoint: (x: number, y: number) => ({ time: x, price: y }),
        indexToTime: () => 1,
        resolveScreenCrosshair: (x: number, y: number) => ({ time: x, price: y }),
        notifyCrosshair: (e: { time: number | null; price: number | null }) => {
          log.push(e.time === null ? "crosshair off" : `crosshair ${round(e.time)},${round(e.price ?? 0)}`);
        },
        autoFit: () => undefined,
        emitVisibleRange: () => undefined,
        hasIndicatorPanes: () => false,
        isChartPaneMaximized: () => false,
        setPriceAutoScaleFromControl: (next: boolean) => log.push(`autoScale ${next}`),
        togglePriceScaleModeFromControl: () => { log.push("log toggle"); return "linear"; },
      };

      const controller = new ChartInputController(canvas, crosshair, host as never);
      const fire = (type: string, pointerId: number, x: number, y: number, pointerType = "touch") => {
        const event = new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId, clientX: x, clientY: y, pointerType });
        canvas.dispatchEvent(event);
        return event;
      };

      return {
        canvas,
        view: host.view,
        crosshair,
        log,
        contextMenus,
        fire,
        wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        controller,
        dispose: () => {
          (controller as { dispose: () => void }).dispose();
          canvas.remove();
        },
      };
    };
  });
}
