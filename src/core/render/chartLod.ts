export type ChartLod = "footprint" | "candlestick" | "pixel-bucket";

export interface OhlcBarLike {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PixelCandleBucket extends OhlcBarLike {
  firstIndex: number;
  lastIndex: number;
  x: number;
}

/** Narrowest column that still carries readable footprint cells. */
export const FOOTPRINT_MIN_COL_WIDTH = 6;
/** Row height below which cell text cannot be set legibly. */
export const CELL_TEXT_MIN_HEIGHT = 9;
/** Footprint width below which no cell text fits at all. */
export const CELL_TEXT_MIN_WIDTH = 44;
/** Below this width only one centred value fits, not a bid/ask pair. */
export const CELL_TEXT_COMPACT_MAX_WIDTH = 72;
/** Row height below which cells are merged per screen pixel instead of drawn. */
export const CELL_PIXEL_MERGE_HEIGHT = 2;

/** Keep footprint detail only while a column is wide enough to remain legible. */
export function chartLodForSpacing(barSpacing: number): ChartLod {
  if (barSpacing >= FOOTPRINT_MIN_COL_WIDTH) return "footprint";
  if (barSpacing >= 1) return "candlestick";
  return "pixel-bucket";
}

export type CellTextMode = "none" | "compact" | "full";

/**
 * How much text a footprint cell can carry at this geometry.
 *
 * The GPU heat layer turns on at FOOTPRINT_MIN_COL_WIDTH while text used to need a
 * much wider column, leaving a broad band where cells were shaded but never labelled
 * and the chart looked broken. "compact" fills that band with a single centred value
 * instead of an unreadable bid/ask pair.
 */
export function cellTextModeFor(cellHeight: number, footprintWidth: number): CellTextMode {
  if (cellHeight < CELL_TEXT_MIN_HEIGHT || footprintWidth < CELL_TEXT_MIN_WIDTH) return "none";
  return footprintWidth < CELL_TEXT_COMPACT_MAX_WIDTH ? "compact" : "full";
}

export interface PriceCellLike {
  priceBin: number;
  buyVol: number;
  sellVol: number;
}

export interface PixelCellBucket {
  yTop: number;
  height: number;
  buyVol: number;
  sellVol: number;
}

/**
 * Merge price cells that land on the same screen pixel into one row.
 *
 * A small price step against a wide price range puts thousands of sub-pixel rows in
 * every column, each clamped to a 1px rect — pure overdraw that reads as a solid
 * block. This is a visual-only aggregation: the series and its cell map are untouched.
 * Volumes are summed so the merged row still shades in proportion to what it covers.
 */
export function buildPixelCellBuckets(
  cells: Iterable<PriceCellLike>,
  step: number,
  yOfPrice: (price: number) => number,
): PixelCellBucket[] {
  const byPixel = new Map<number, PixelCellBucket>();
  for (const cell of cells) {
    const yTop = Math.floor(yOfPrice(cell.priceBin + step));
    const existing = byPixel.get(yTop);
    if (existing) {
      existing.buyVol += cell.buyVol;
      existing.sellVol += cell.sellVol;
      continue;
    }
    byPixel.set(yTop, {
      yTop,
      height: Math.max(yOfPrice(cell.priceBin) - yTop, 1),
      buyVol: cell.buyVol,
      sellVol: cell.sellVol,
    });
  }
  return [...byPixel.values()].sort((a, b) => a.yTop - b.yTop);
}

/**
 * Merge consecutive bars that land on the same CSS pixel. This is a visual-only
 * aggregation: logical indices and the underlying series remain untouched.
 */
export function buildPixelCandleBuckets(
  from: number,
  to: number,
  barAt: (index: number) => OhlcBarLike | undefined,
  xOfIndex: (index: number) => number,
): PixelCandleBucket[] {
  const buckets: PixelCandleBucket[] = [];
  let current: PixelCandleBucket | undefined;

  for (let index = from; index < to; index++) {
    const bar = barAt(index);
    if (!bar) continue;
    const x = Math.floor(xOfIndex(index));

    if (!current || current.x !== x) {
      current = {
        firstIndex: index,
        lastIndex: index,
        x,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      };
      buckets.push(current);
      continue;
    }

    current.lastIndex = index;
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
  }

  return buckets;
}
