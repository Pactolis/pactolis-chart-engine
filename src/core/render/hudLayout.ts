/**
 * Layout of the bar readout (open, high, low, close, volume, delta ...) at the top of the plot.
 *
 * On a wide plot the readout is one line. A narrow plot (a phone, a small pane) cannot hold that
 * line, so the parts flow into rows, and when even a few rows are not enough the least useful parts
 * are left out instead of running over the price axis.
 */

/** One piece of the readout. */
export interface HudPart {
  text: string;
  color: string;
  /** 0 never drops. When the readout has to shrink, the part with the highest number goes first. */
  dropOrder: number;
}

export interface HudPlacedPart {
  text: string;
  color: string;
  /** Left edge of the text inside its row, in px. */
  x: number;
}

export interface HudRow {
  parts: HudPlacedPart[];
  width: number;
}

export interface HudLayout {
  rows: HudRow[];
  /** Width of the widest row. */
  width: number;
}

/** Vertical advance of one readout row, in px. */
export const HUD_ROW_HEIGHT = 15;

/** How many rows the readout may use on a plot this tall; a short pane keeps its room for candles. */
export function hudMaxRows(plotHeight: number): number {
  if (plotHeight >= 400) return 3;
  if (plotHeight >= 220) return 2;
  return 1;
}

/**
 * Flow `parts` left to right into rows no wider than `maxWidth`. Order is kept. When more than
 * `maxRows` rows result, the droppable part with the highest `dropOrder` (the later one on a tie) is
 * removed and the flow repeated; once only parts that never drop remain, the rows past `maxRows` are cut.
 * `measure` returns a text's width in px and `gap` is the space between two parts of a row.
 */
export function layoutHud(
  parts: readonly HudPart[],
  measure: (text: string) => number,
  maxWidth: number,
  maxRows: number,
  gap: number,
): HudLayout {
  const widths = new Map<HudPart, number>();
  for (const part of parts) widths.set(part, measure(part.text));
  const active = [...parts];
  for (;;) {
    const rows = flow(active, widths, maxWidth, gap);
    if (rows.length <= maxRows) return finish(rows);
    let drop = -1;
    let worst = 0;
    active.forEach((part, index) => {
      if (part.dropOrder > 0 && part.dropOrder >= worst) {
        worst = part.dropOrder;
        drop = index;
      }
    });
    if (drop < 0) return finish(rows.slice(0, Math.max(1, maxRows)));
    active.splice(drop, 1);
  }
}

function flow(parts: readonly HudPart[], widths: ReadonlyMap<HudPart, number>, maxWidth: number, gap: number): HudRow[] {
  const rows: HudRow[] = [];
  let row: HudRow | null = null;
  let x = 0;
  for (const part of parts) {
    const width = widths.get(part) ?? 0;
    if (row === null || (row.parts.length > 0 && x + width > maxWidth)) {
      row = { parts: [], width: 0 };
      rows.push(row);
      x = 0;
    }
    row.parts.push({ text: part.text, color: part.color, x });
    x += width + gap;
    row.width = x - gap;
  }
  return rows;
}

function finish(rows: HudRow[]): HudLayout {
  return { rows, width: rows.reduce((widest, row) => Math.max(widest, row.width), 0) };
}
