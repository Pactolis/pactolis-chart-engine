import type { View } from "../../engine/view.js";
import type { FootprintSeries } from "../../model/footprint.js";
import type { IndicatorPaneRender } from "../../indicatorTypes.js";
import { crosshairLineColor, syncCrosshairLineColor } from "../../ui/seriesPalette.js";
import {
  drawIndicatorScaleControls,
  drawPriceScaleControls,
  type IndicatorScaleControlRect,
  type PriceScaleControlRect,
} from "../axisControlsRenderer.js";
import { drawCrosshairPriceLabel } from "../priceAxisRenderer.js";
import { drawCrosshairTimeLabel } from "../timeAxisRenderer.js";
import {
  drawTouchMenuButton,
  touchMenuButtonRect,
  type TouchMenuButtonRect,
} from "../touchControlsRenderer.js";
import { drawHud, type HudRendererDeps } from "./hudRenderer.js";

export interface Crosshair {
  x: number;
  y: number;
  visible: boolean;
  /** The user is on a touch screen: the overlay shows finger-sized scale buttons and the corner menu button. */
  touch?: boolean;
}

export interface InteractionOverlayHost extends HudRendererDeps {
  readonly ctx: CanvasRenderingContext2D;
  readonly interactionCtx?: CanvasRenderingContext2D;
  readonly isMainChartSuppressed?: () => boolean;
  readonly getIndicatorPanes?: () => IndicatorPaneRender[];
  readonly drawInteractionForeground?: (ctx: CanvasRenderingContext2D, view: View, series: FootprintSeries) => void;
  readonly drawOrderbookHover?: (
    ctx: CanvasRenderingContext2D,
    view: View,
    series: FootprintSeries,
    crosshair: Crosshair,
  ) => void;
  resetInteractionHitRects(): void;
  setPriceScaleControlRects(rects: PriceScaleControlRect[]): void;
  pushIndicatorScaleControlRects(rects: IndicatorScaleControlRect[]): void;
  setTouchMenuButton(rect: TouchMenuButtonRect | null): void;
}

/** High-frequency pointer/selection surface. Scene layer order is the render authority. */
export function renderInteractionPass(
  host: InteractionOverlayHost,
  view: View,
  series: FootprintSeries,
  crosshair: Crosshair,
  range: [number, number],
  layerOrder?: readonly string[],
): void {
  void range;
  const ctx = host.interactionCtx ?? host.ctx;
  const orderedLayers = layerOrder ?? ["crosshair", "hud", "interaction-controls"];
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  host.resetInteractionHitRects();

  if (series.length === 0) {
    host.onHudText?.(null);
    return;
  }

  const mainSuppressed = host.isMainChartSuppressed?.() === true;
  for (const layerId of orderedLayers) {
    switch (layerId) {
      case "crosshair": {
        if (mainSuppressed) {
          if (crosshair.visible) drawCrosshairTimeLabel(ctx, view, series, crosshair);
          break;
        }
        const syncTime = host.getSyncCrosshairTime?.();
        if (syncTime != null) {
          const startTime = series.at(0)?.startTime;
          if (startTime !== undefined) {
            const idx = (syncTime - startTime) / series.config.intervalMs;
            const x = view.xOfIndex(idx) + view.colWidth / 2;
            drawSyncCrosshair(ctx, view, x);
          }
        }
        if (crosshair.visible) {
          drawCrosshair(ctx, view, crosshair);
          drawCrosshairPriceLabel(ctx, view, series, crosshair, host.displayOptions);
          drawCrosshairTimeLabel(ctx, view, series, crosshair);
        }
        break;
      }
      case "hud":
        // Hovered HUD remains above the crosshair on Interaction; default HUD lives on Annotation.
        if (!mainSuppressed && crosshair.visible) drawHud(ctx, view, series, crosshair, range, host);
        if (!mainSuppressed) host.drawOrderbookHover?.(ctx, view, series, crosshair);
        break;
      case "interaction-controls": {
        if (!mainSuppressed) host.drawInteractionForeground?.(ctx, view, series);
        if (!mainSuppressed) host.setPriceScaleControlRects(drawPriceScaleControls(ctx, view, crosshair));
        drawIndicatorInteractionControls(host, ctx, view, crosshair);
        // The crosshair has the plot to itself while the finger inspects.
        if (crosshair.touch && !crosshair.visible) {
          const touchMenuButton = touchMenuButtonRect(view);
          host.setTouchMenuButton(touchMenuButton);
          if (touchMenuButton) drawTouchMenuButton(ctx, touchMenuButton);
        }
        break;
      }
    }
  }
}

function drawIndicatorInteractionControls(
  host: InteractionOverlayHost,
  ctx: CanvasRenderingContext2D,
  view: View,
  crosshair: Crosshair,
): void {
  const panes = host.getIndicatorPanes?.() ?? [];
  if (!panes.length || view.priceAxisW <= 0) return;
  const axisX = view.area.left + view.area.width;
  let top = view.area.top + view.area.height;
  for (const pane of panes) {
    host.pushIndicatorScaleControlRects(drawIndicatorScaleControls(
      ctx, axisX, view.priceAxisW,
      { id: pane.id, top, height: pane.height, scaleMode: pane.scaleMode },
      crosshair,
    ));
    top += pane.height;
  }
}

function drawCrosshair(ctx: CanvasRenderingContext2D, view: View, ch: Crosshair): void {
  ctx.strokeStyle = crosshairLineColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(ch.x, view.area.top);
  ctx.lineTo(ch.x, view.area.top + view.area.height);
  ctx.moveTo(view.area.left, ch.y);
  ctx.lineTo(view.area.left + view.area.width, ch.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Draw a ghost/sync crosshair as a vertical dashed line. Only vertical line is drawn;
 *  no horizontal or HUD labels. */
function drawSyncCrosshair(ctx: CanvasRenderingContext2D, view: View, x: number): void {
  ctx.save();
  ctx.strokeStyle = syncCrosshairLineColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, view.area.top);
  ctx.lineTo(x, view.area.top + view.area.height);
  ctx.stroke();
  ctx.restore();
}
