import type { View } from "../../core/engine/view.js";
import type { FootprintSeries } from "../../core/model/footprint.js";
import { settings } from "../../core/settings.js";
import { isDrawingMagnetEnabled, snapPriceToOhlc, WEAK_MAGNET_THRESHOLD_PX } from "./ChartInputController.js";
import { ChartChange } from "../../core/render/scene/chartScene.js";
import type { AnalysisContext } from "../../core/analysisContext.js";

export interface MagnetSnapTarget {
  x: number;
  y: number;
  price: number;
  time: number;
  label: string;
}

export const MAGNET_SNAP_THRESHOLD_CSS_PX = 14;

export interface ChartMagnetHost {
  readonly view: View;
  readonly pipeline: { readonly series: FootprintSeries };
  readonly state: { readonly market: string };
  readonly session?: { invalidate(changes?: ChartChange): void };
  readonly overlay?: { getActiveVolumeProfileLevels?(): { poc: number | null; vah: number | null; val: number | null } | null };
  setHookAttr?(name: string, value: string): void;
  analysisContextForChart(): AnalysisContext;
}

/**
 * Manages drawing magnetic snap calculations, target resolution, and snap halo/badge rendering.
 */
export class ChartMagnetController {
  activeMagnetSnap: MagnetSnapTarget | null = null;

  constructor(private readonly host: ChartMagnetHost) {}

  clearMagnetSnap(): void {
    if (this.activeMagnetSnap !== null) {
      this.activeMagnetSnap = null;
      this.host.setHookAttr?.("data-magnet-snap", "");
      this.host.session?.invalidate(typeof ChartChange !== "undefined" ? ChartChange.Interaction : (1 << 4));
    }
  }

  indexToTime(index: number): number | null {
    const series = this.host.pipeline.series;
    return series.length === 0 ? null : series.timeOfIndex(index);
  }

  screenToDrawingPoint(cx: number, cy: number, temporaryMagnet = false): { time: number; price: number } {
    const idx = this.host.view.indexOfX(cx);
    const magnetEnabled = isDrawingMagnetEnabled(settings.magnet, temporaryMagnet);
    let defaultTime: number;
    if (!magnetEnabled && this.host.analysisContextForChart().drawings?.activeTool === "brush") {
      // Brush drafts keep fractional sub-bar x; raw logical x sits on a column edge, so recenter by half a column.
      defaultTime = this.indexToTime(idx - 0.5) ?? Date.now();
    } else {
      defaultTime = this.indexToTime(Math.round(idx)) ?? Date.now();
    }
    const rawPrice = this.host.view.priceOfY(cy);

    if (!magnetEnabled) {
      this.clearMagnetSnap();
      return { time: defaultTime, price: rawPrice };
    }

    if (this.host.analysisContextForChart().drawings?.activeTool === "brush") {
      this.clearMagnetSnap();
      const forceNearest = settings.magnetMode === "strong" || temporaryMagnet;
      const snappedPrice = this.magnetSnapPrice(idx, cy, rawPrice, forceNearest);
      return { time: defaultTime, price: snappedPrice };
    }

    return this.resolveMagnetSnap(cx, cy, rawPrice, defaultTime, idx, temporaryMagnet);
  }

  magnetSnapPrice(idx: number, cy: number, rawPrice: number, forceNearest: boolean): number {
    const bar = this.host.pipeline.series.at(Math.round(idx));
    if (!bar) return rawPrice;
    return snapPriceToOhlc(
      rawPrice,
      cy,
      [bar.open, bar.high, bar.low, bar.close],
      (value) => this.host.view.yOfPrice(value),
      forceNearest,
    );
  }

  resolveMagnetSnap(
    cx: number,
    cy: number,
    rawPrice: number,
    defaultTime: number,
    idx: number,
    temporaryMagnet: boolean,
  ): { time: number; price: number } {
    const forceNearest = settings.magnetMode === "strong" || temporaryMagnet;
    interface SnapCandidate {
      x: number;
      y: number;
      price: number;
      time: number;
      label: string;
      distancePx: number;
    }
    const candidates: SnapCandidate[] = [];

    // 1. Drawing anchors
    const drawings = this.host.analysisContextForChart().drawings;
    if (drawings) {
      const currentList = drawings.listCurrentReadonly ? drawings.listCurrentReadonly() : (drawings.listCurrent?.() ?? []);
      const isDragActive = drawings.isPointerDragActive?.() === true;
      const selectedSet = new Set(drawings.getSelectedIds?.() ?? []);
      for (const d of currentList) {
        if (!d.visible) continue;
        if (isDragActive && selectedSet.has(d.id)) continue;
        for (const pt of d.points) {
          if (typeof pt.price !== "number" || typeof pt.time !== "number") continue;
          const ptIdx = this.host.pipeline.series.indexOfTime(pt.time);
          const ax = this.host.view.xOfIndex(ptIdx);
          const ay = this.host.view.yOfPrice(pt.price);
          if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
          const dist = Math.hypot(ax - cx, ay - cy);
          if (forceNearest || dist <= MAGNET_SNAP_THRESHOLD_CSS_PX) {
            candidates.push({ x: ax, y: ay, price: pt.price, time: pt.time, label: "ANCHOR", distancePx: dist });
          }
        }
      }
    }

    // 2. Primary Bar OHLC + POC
    const barIdx = Math.round(idx);
    const bar = this.host.pipeline.series.at(barIdx);
    if (bar) {
      const barX = this.host.view.xOfIndex(barIdx);
      const barTime = this.indexToTime(barIdx) ?? bar.startTime;
      const ohlcLevels: Array<{ price: number; label: string }> = [
        { price: bar.open, label: "O" },
        { price: bar.high, label: "H" },
        { price: bar.low, label: "L" },
        { price: bar.close, label: "C" },
      ];

      // Bar POC if footprint cells exist
      if (bar.cells && bar.cells.size > 0) {
        let maxVol = 0;
        let pocPrice: number | null = null;
        const step = this.host.pipeline.series.config?.priceStep ?? 0;
        for (const cell of bar.cells.values()) {
          const v = cell.buyVol + cell.sellVol;
          if (v > maxVol) {
            maxVol = v;
            pocPrice = cell.priceBin + step / 2;
          }
        }
        if (pocPrice !== null) {
          ohlcLevels.push({ price: pocPrice, label: "POC" });
        }
      }

      for (const { price: lvlPrice, label: lvlLabel } of ohlcLevels) {
        const lvlY = this.host.view.yOfPrice(lvlPrice);
        const distY = Math.abs(lvlY - cy);
        if (forceNearest || distY <= WEAK_MAGNET_THRESHOLD_PX) {
          candidates.push({ x: barX, y: lvlY, price: lvlPrice, time: barTime, label: lvlLabel, distancePx: distY });
        }
      }
    }

    // 3. Neighbor Bar (+-1 bar wicks: High / Low)
    for (const offset of [-1, 1]) {
      const nIdx = barIdx + offset;
      const nBar = this.host.pipeline.series.at(nIdx);
      if (!nBar) continue;
      const nX = this.host.view.xOfIndex(nIdx);
      const nTime = this.indexToTime(nIdx) ?? nBar.startTime;
      for (const [nPrice, nLabel] of [[nBar.high, "H"], [nBar.low, "L"]] as const) {
        const nY = this.host.view.yOfPrice(nPrice);
        const dist = Math.hypot(nX - cx, nY - cy);
        if (forceNearest || dist <= WEAK_MAGNET_THRESHOLD_PX) {
          candidates.push({ x: nX, y: nY, price: nPrice, time: nTime, label: nLabel, distancePx: dist });
        }
      }
    }

    // 4. Volume Profile levels (PPOC, VAH, VAL)
    const vpLevels = this.host.overlay?.getActiveVolumeProfileLevels?.() ?? null;
    if (vpLevels) {
      const profileItems: Array<{ price: number | null; label: string }> = [
        { price: vpLevels.poc, label: "PPOC" },
        { price: vpLevels.vah, label: "VAH" },
        { price: vpLevels.val, label: "VAL" },
      ];
      for (const { price: vpPrice, label: vpLabel } of profileItems) {
        if (vpPrice === null || !Number.isFinite(vpPrice)) continue;
        const vpY = this.host.view.yOfPrice(vpPrice);
        const vpDistY = Math.abs(vpY - cy);
        if (forceNearest || vpDistY <= WEAK_MAGNET_THRESHOLD_PX) {
          candidates.push({ x: cx, y: vpY, price: vpPrice, time: defaultTime, label: vpLabel, distancePx: vpDistY });
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.distancePx - b.distancePx);
      const best = candidates[0];
      this.activeMagnetSnap = { x: best.x, y: best.y, price: best.price, time: best.time, label: best.label };
      this.host.setHookAttr?.("data-magnet-snap", best.label);
      this.host.session?.invalidate(typeof ChartChange !== "undefined" ? ChartChange.Interaction : (1 << 4));
      return { time: best.time, price: best.price };
    }

    this.clearMagnetSnap();
    return { time: defaultTime, price: rawPrice };
  }

  drawMagnetSnapRing(
    ctx: CanvasRenderingContext2D,
    view: View,
    snap: { x: number; y: number; label: string },
  ): void {
    const { x, y, label } = snap;
    if (x < view.area.left - 20 || x > view.area.left + view.area.width + 20) return;
    if (y < view.area.top - 20 || y > view.area.top + view.area.height + 20) return;

    ctx.save();
    // Halo
    ctx.beginPath();
    ctx.arc(x, y, 7.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(41, 98, 255, 0.4)";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Core ring
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = "#2962ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // Badge
    if (label) {
      ctx.font = "bold 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      const padX = 4;
      const metrics = ctx.measureText(label);
      const badgeW = metrics.width + padX * 2;
      const badgeH = 13;
      const bx = x + 10;
      const by = y - 6;

      ctx.fillStyle = "rgba(24, 28, 38, 0.9)";
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeW, badgeH, 2.5);
      ctx.fill();
      ctx.strokeStyle = "#2962ff";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#e0e6ed";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + padX, by + badgeH / 2);
    }
    ctx.restore();
  }
}
