import type { QuadBatch } from "../engine/quadBatch.js";
import type { RGBA } from "../engine/gl.js";
import type { View } from "../engine/view.js";
import type { TimeMark } from "../model/timeScale.js";

const TIME_GRID: RGBA = { r: 1, g: 1, b: 1, a: 0.055 };

/** Vertical grid is derived from horizontal time-scale marks, not real bar data. */
export function drawTimeGrid(batch: QuadBatch, view: View, marks: readonly TimeMark[]): void {
  for (const mark of marks) {
    const x = Math.round(mark.coord);
    if (x < view.area.left - 1 || x > view.area.left + view.area.width + 1) continue;
    batch.rect(x, view.area.top, 1, view.area.height, TIME_GRID);
  }
}
