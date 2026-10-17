import type { TimeScalePoint } from "./timeScale.js";

export interface TimeTickMarkBuildOptions {
  /** Keep or skip all marks of one weight together, so labels of a kind stay evenly spaced. */
  readonly uniformDistribution: boolean;
  /** Never label generated/projected whitespace points. */
  readonly ignoreWhitespaceIndices: boolean;
}

/**
 * Time tick selection.
 *
 * TimeScaleModel owns point/time-weight generation; this class owns label-density
 * selection. Keeping this outside the renderer prevents time-axis/grid label
 * policy from leaking into draw code.
 */
export class TimeTickMarks {
  private readonly uniformDistribution: boolean;
  private readonly ignoreWhitespaceIndices: boolean;

  constructor(options: TimeTickMarkBuildOptions) {
    this.uniformDistribution = options.uniformDistribution;
    this.ignoreWhitespaceIndices = options.ignoreWhitespaceIndices;
  }

  build(points: readonly TimeScalePoint[], spacing: number, maxLabelWidth: number): TimeScalePoint[] {
    if (points.length === 0 || spacing <= 0 || maxLabelWidth <= 0) return [];
    const candidates = this.ignoreWhitespaceIndices
      ? points.filter((point) => !point.whitespace)
      : [...points];
    // Maximum zoom-out deliberately permits sub-pixel bar spacing. Clamping that
    // spacing to 1px underestimates the logical gap by up to 20x (0.19125px was
    // measured live), so 75px-wide labels were selected only 17.2px apart.
    const minIndexDistance = Math.max(1, Math.ceil(maxLabelWidth / spacing));
    const byWeight = groupByWeight(candidates);
    const selected: TimeScalePoint[] = [];
    for (const weight of [...byWeight.keys()].sort((a, b) => b - a)) {
      const bucket = byWeight.get(weight) ?? [];
      if (this.uniformDistribution) {
        if (canAddAll(bucket, selected, minIndexDistance)) selected.push(...bucket);
        continue;
      }
      for (const point of bucket) {
        if (canAddOne(point, selected, minIndexDistance)) selected.push(point);
      }
    }
    return selected.sort((a, b) => a.index - b.index);
  }
}

function groupByWeight(points: readonly TimeScalePoint[]): Map<number, TimeScalePoint[]> {
  const byWeight = new Map<number, TimeScalePoint[]>();
  for (const point of points) {
    const bucket = byWeight.get(point.timeWeight) ?? [];
    bucket.push(point);
    byWeight.set(point.timeWeight, bucket);
  }
  for (const bucket of byWeight.values()) bucket.sort((a, b) => a.index - b.index);
  return byWeight;
}

function canAddAll(bucket: readonly TimeScalePoint[], selected: readonly TimeScalePoint[], minIndexDistance: number): boolean {
  for (let i = 0; i < bucket.length; i++) {
    if (!canAddOne(bucket[i], selected, minIndexDistance)) return false;
    for (let j = 0; j < i; j++) {
      if (Math.abs(bucket[i].index - bucket[j].index) < minIndexDistance) return false;
    }
  }
  return true;
}

function canAddOne(point: TimeScalePoint, selected: readonly TimeScalePoint[], minIndexDistance: number): boolean {
  return selected.every((item) => Math.abs(item.index - point.index) >= minIndexDistance);
}
