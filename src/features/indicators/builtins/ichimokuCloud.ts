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
  const segments: IchimokuCloudSegment[] = [];
  let j = 0;
  let prevIndex = -1;
  let prevA: number | null = null;
  let prevB: number | null = null;
  let hasPrev = false;

  for (let i = 0; i < senkouA.length; i++) {
    const pointA = senkouA[i];
    const idx = pointA.index;
    if (i > 0 && idx < senkouA[i - 1].index) {
      return ichimokuCloudSegmentsFallback(senkouA, senkouB);
    }
    while (j < senkouB.length && senkouB[j].index < idx) {
      if (j > 0 && senkouB[j].index < senkouB[j - 1].index) {
        return ichimokuCloudSegmentsFallback(senkouA, senkouB);
      }
      j++;
    }
    if (j > 0 && j < senkouB.length && senkouB[j].index < senkouB[j - 1].index) {
      return ichimokuCloudSegmentsFallback(senkouA, senkouB);
    }
    let bVal: number | null = null;
    if (j < senkouB.length && senkouB[j].index === idx) {
      bVal = senkouB[j].value;
      // If duplicate index exists later in senkouB, take the last one (Map parity).
      while (j + 1 < senkouB.length && senkouB[j + 1].index === idx) {
        j++;
        bVal = senkouB[j].value;
      }
    }

    const aVal = pointA.value;
    if (
      hasPrev
      && idx === prevIndex + 1
      && prevA !== null
      && prevB !== null
      && aVal !== null
      && bVal !== null
    ) {
      segments.push({
        fromIndex: prevIndex,
        toIndex: idx,
        aFrom: prevA,
        aTo: aVal,
        bFrom: prevB,
        bTo: bVal,
        bullish: (prevA + aVal) / 2 >= (prevB + bVal) / 2,
      });
    }
    hasPrev = true;
    prevIndex = idx;
    prevA = aVal;
    prevB = bVal;
  }
  return segments;
}

function ichimokuCloudSegmentsFallback(
  senkouA: readonly IchimokuCloudPoint[],
  senkouB: readonly IchimokuCloudPoint[],
): IchimokuCloudSegment[] {
  const byIndexB = new Map<number, number | null>();
  for (const point of senkouB) byIndexB.set(point.index, point.value);
  const segments: IchimokuCloudSegment[] = [];
  for (let i = 1; i < senkouA.length; i++) {
    const from = senkouA[i - 1];
    const to = senkouA[i];
    const bFrom = byIndexB.get(from.index) ?? null;
    const bTo = byIndexB.get(to.index) ?? null;
    if (to.index !== from.index + 1 || from.value === null || bFrom === null || to.value === null || bTo === null) continue;
    segments.push({
      fromIndex: from.index,
      toIndex: to.index,
      aFrom: from.value,
      aTo: to.value,
      bFrom,
      bTo,
      bullish: (from.value + to.value) / 2 >= (bFrom + bTo) / 2,
    });
  }
  return segments;
}
