export interface LevelAnchorView {
  area: { left: number };
  xOfIndex(index: number): number;
}

export interface LevelAnchorSeries {
  indexOfTime(time: number): number;
}

/** Resolve a timestamp through the real series index so chunk gaps cannot shift level starts. */
export function levelStartX(
  view: LevelAnchorView,
  series: LevelAnchorSeries,
  time: number,
): number {
  return Math.max(view.area.left, view.xOfIndex(series.indexOfTime(time)));
}
