import {
  cellImbalance,
  getFootprintBarKeysRevision,
  getFootprintCellRevision,
  type FootprintSeries,
} from "../../model/footprint.js";
import { cellAverageTradeSize, cellAverageTradeSizes, cellDeltaPercent, cellTradeCounts } from "../../model/footprintCellMetrics.js";
import type { FootprintCellData } from "../../settings.js";
import type { FootprintBar, FootprintCell } from "../../types.js";
import { cellDimBuy, cellDimSell, uiColor } from "../../ui/seriesPalette.js";
import { fmtNotional, fmtVol } from "./hudRenderer.js";

export interface FormattedCellText {
  centerText?: string;
  centerColor?: string;
  leftText?: string;
  leftColor?: string;
  rightText?: string;
  rightColor?: string;
}

export interface BarCellTextCacheEntry {
  key: string;
  cellRevision: number;
  entries: Map<number, FormattedCellText>;
  cellRevisions?: Map<number, number>;
  cellRefs?: Map<number, FootprintCell>;
  cellKeysRevision?: number;
}

const MAX_COLOR_CACHE_ENTRIES = 256;
const cssColorRgbaCache = new Map<string, number>();

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function packRgba8(r: number, g: number, b: number, a = 255): number {
  return (((clampByte(a) << 24) | (clampByte(b) << 16) | (clampByte(g) << 8) | clampByte(r)) >>> 0);
}

/**
 * Parses CSS `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, or `rgba(...)` strings
 * into little-endian packed RGBA8 (`u32`, matching WGSL `unpack4x8unorm` / `unorm8x4`).
 */
export function parseCssColorToPackedRgba(cssColor: string): number {
  const cached = cssColorRgbaCache.get(cssColor);
  if (cached !== undefined) return cached;

  let packed = 0xffffffff;
  const trimmed = cssColor.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) : 255;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        packed = packRgba8(r, g, b, a);
      }
    } else if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        packed = packRgba8(r, g, b, a);
      }
    }
  } else {
    const match = /^rgba?\(\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)(?:\s*,\s*([+-]?\d*\.?\d+))?\s*\)$/i.exec(trimmed);
    if (match) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = match[4] !== undefined ? Number(match[4]) * 255 : 255;
      packed = packRgba8(r, g, b, a);
    }
  }

  if (cssColorRgbaCache.size >= MAX_COLOR_CACHE_ENTRIES) {
    cssColorRgbaCache.clear();
  }
  cssColorRgbaCache.set(cssColor, packed);
  return packed;
}

export function fmtCellValue(v: number, bp: number, showNotional: boolean): string {
  return showNotional ? fmtNotional(v * bp) : fmtVol(v);
}

export function cellTextCacheKey(
  mode: FootprintCellData,
  compact: boolean,
  showNotional: boolean,
  step: number,
): string {
  return `${mode}|${compact ? 1 : 0}|${showNotional ? 1 : 0}|${step}`;
}

export function getOrCreateBarCellTextEntries(
  cache: WeakMap<FootprintBar, BarCellTextCacheEntry>,
  bar: FootprintBar,
  cacheKey: string,
): Map<number, FormattedCellText> | null {
  if (bar.cellRevision === undefined) return null;
  const existing = cache.get(bar);
  if (existing && existing.key === cacheKey && existing.cellRevision === bar.cellRevision) {
    return existing.entries;
  }
  const entries = new Map<number, FormattedCellText>();
  cache.set(bar, { key: cacheKey, cellRevision: bar.cellRevision, entries });
  return entries;
}

export function getOrCreateBarCellTextCache(
  cache: WeakMap<FootprintBar, BarCellTextCacheEntry>,
  bar: FootprintBar,
  cacheKey: string,
): BarCellTextCacheEntry | null {
  if (bar.cellRevision === undefined) return null;
  const barKeysRev = getFootprintBarKeysRevision(bar);
  const existing = cache.get(bar);
  if (existing && existing.key === cacheKey) {
    if (existing.cellRevision === bar.cellRevision) {
      return existing;
    }
    if (
      barKeysRev !== undefined
      && existing.cellRevisions !== undefined
      && existing.cellRefs !== undefined
    ) {
      if (existing.cellKeysRevision !== barKeysRev && existing.entries.size > bar.cells.size) {
        for (const key of existing.entries.keys()) {
          if (!bar.cells.has(key)) {
            existing.entries.delete(key);
            existing.cellRevisions.delete(key);
            existing.cellRefs.delete(key);
          }
        }
      }
      existing.cellRevision = bar.cellRevision;
      existing.cellKeysRevision = barKeysRev;
      return existing;
    }
  }
  const entry: BarCellTextCacheEntry = {
    key: cacheKey,
    cellRevision: bar.cellRevision,
    entries: new Map<number, FormattedCellText>(),
    cellRevisions: new Map<number, number>(),
    cellRefs: new Map<number, FootprintCell>(),
    cellKeysRevision: barKeysRev,
  };
  cache.set(bar, entry);
  return entry;
}

export function getOrFormatBarCellText(
  barCache: BarCellTextCacheEntry | null,
  cell: FootprintCell,
  mode: FootprintCellData,
  compact: boolean,
  step: number,
  showNotional: boolean,
): FormattedCellText {
  if (barCache !== null) {
    const cached = barCache.entries.get(cell.priceBin);
    if (cached !== undefined) {
      if (barCache.cellKeysRevision === undefined) return cached;
      const rev = getFootprintCellRevision(cell);
      if (
        barCache.cellRevisions?.get(cell.priceBin) === rev
        && barCache.cellRefs?.get(cell.priceBin) === cell
      ) {
        return cached;
      }
    }
  }
  const formatted = formatFootprintCellText(cell, mode, compact, step, showNotional);
  if (barCache !== null) {
    barCache.entries.set(cell.priceBin, formatted);
    barCache.cellRevisions?.set(cell.priceBin, getFootprintCellRevision(cell));
    barCache.cellRefs?.set(cell.priceBin, cell);
  }
  return formatted;
}

export function formatFootprintCellText(
  cell: FootprintCell,
  mode: FootprintCellData,
  compact: boolean,
  step: number,
  showNotional: boolean,
): FormattedCellText {
  const binPrice = cell.priceBin + step / 2;
  if (mode === "bidask") {
    const imb = cellImbalance(cell);
    if (compact) {
      return {
        centerText: fmtCellValue(cell.buyVol + cell.sellVol, binPrice, showNotional),
        centerColor: imb > 0.3 ? uiColor.buy : imb < -0.3 ? uiColor.sell : uiColor.text,
      };
    }
    return {
      leftText: fmtCellValue(cell.sellVol, binPrice, showNotional),
      leftColor: imb < -0.3 ? uiColor.sell : cellDimSell,
      rightText: fmtCellValue(cell.buyVol, binPrice, showNotional),
      rightColor: imb > 0.3 ? uiColor.buy : cellDimBuy,
    };
  }
  if (mode === "volume") {
    return {
      centerText: fmtCellValue(cell.buyVol + cell.sellVol, binPrice, showNotional),
      centerColor: uiColor.text,
    };
  }
  if (mode === "count") {
    const counts = cellTradeCounts(cell);
    return {
      centerText: fmtVol(counts.total),
      centerColor: uiColor.text,
    };
  }
  if (mode === "countBidask") {
    const counts = cellTradeCounts(cell);
    if (compact) {
      return {
        centerText: fmtVol(counts.total),
        centerColor: uiColor.text,
      };
    }
    return {
      leftText: fmtVol(counts.sell),
      leftColor: counts.sell > counts.buy ? uiColor.sell : cellDimSell,
      rightText: fmtVol(counts.buy),
      rightColor: counts.buy > counts.sell ? uiColor.buy : cellDimBuy,
    };
  }
  if (mode === "deltaPct") {
    const deltaPct = cellDeltaPercent(cell);
    const sign = deltaPct > 0 ? "+" : deltaPct < 0 ? "-" : "";
    return {
      centerText: `${sign}${Math.abs(deltaPct).toFixed(0)}%`,
      centerColor: deltaPct > 0 ? uiColor.buy : deltaPct < 0 ? uiColor.sell : uiColor.textSecondary,
    };
  }
  if (mode === "avgTradeSize") {
    return {
      centerText: fmtCellValue(cellAverageTradeSize(cell), binPrice, showNotional),
      centerColor: uiColor.text,
    };
  }
  if (mode === "avgTradeSizeBidask") {
    const averages = cellAverageTradeSizes(cell);
    if (compact) {
      return {
        centerText: fmtCellValue(cellAverageTradeSize(cell), binPrice, showNotional),
        centerColor: uiColor.text,
      };
    }
    return {
      leftText: fmtCellValue(averages.sell, binPrice, showNotional),
      leftColor: averages.sell > averages.buy ? uiColor.sell : cellDimSell,
      rightText: fmtCellValue(averages.buy, binPrice, showNotional),
      rightColor: averages.buy > averages.sell ? uiColor.buy : cellDimBuy,
    };
  }
  const delta = cell.buyVol - cell.sellVol;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return {
    centerText: sign + fmtCellValue(Math.abs(delta), binPrice, showNotional),
    centerColor: delta > 0 ? uiColor.buy : delta < 0 ? uiColor.sell : uiColor.textSecondary,
  };
}

export type { FootprintSeries };
