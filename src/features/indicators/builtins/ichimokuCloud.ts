export interface IchimokuCloudPoint {
  index: number;
  value: number | null;
}

export interface IchimokuCloudSegment {
  fromIndex: number;
  toIndex: number;
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
  bullish: boolean;
}

export function ichimokuCloudSegments(
  senkouA: readonly IchimokuCloudPoint[],
  senkouB: readonly IchimokuCloudPoint[],
): IchimokuCloudSegment[] {
  const byIndexB = new Map(senkouB.map((point) => [point.index, point.value]));
  const paired = senkouA.map((point) => ({ index: point.index, a: point.value, b: byIndexB.get(point.index) ?? null }));
  const segments: IchimokuCloudSegment[] = [];
  for (let i = 1; i < paired.length; i++) {
    const from = paired[i - 1];
    const to = paired[i];
    if (to.index !== from.index + 1 || from.a === null || from.b === null || to.a === null || to.b === null) continue;
    segments.push({
      fromIndex: from.index,
      toIndex: to.index,
      aFrom: from.a,
      aTo: to.a,
      bFrom: from.b,
      bTo: to.b,
      bullish: (from.a + to.a) / 2 >= (from.b + to.b) / 2,
    });
  }
  return segments;
}
