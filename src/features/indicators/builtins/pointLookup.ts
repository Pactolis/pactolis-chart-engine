/**
 * Binary-searches a point array sorted in ascending `point.index` order.
 */
export function findPointByIndex<T extends { index: number }>(
  points: readonly T[],
  targetIndex: number,
): T | null {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    const pointIndex = point.index;
    if (pointIndex === targetIndex) return point;
    if (pointIndex < targetIndex) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/**
 * Returns the last point with `hasData === true` by scanning backwards without copying,
 * falling back to the last point or `null` when empty.
 */
export function findLastPointWithData<T extends { hasData: boolean }>(
  points: readonly T[],
): T | null {
  if (points.length === 0) return null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].hasData) return points[i];
  }
  return points[points.length - 1] ?? null;
}
