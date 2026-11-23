import type { FootprintSeries } from "../../core/model/footprint.js";

export type IndicatorSeriesMutationKind = "initial" | "structure" | "tail" | "non-tail" | "metadata";

export interface IndicatorSeriesMutationSummary {
  kind: IndicatorSeriesMutationKind;
  revision: number;
  structureRevision: number;
  tailIndex: number;
}

interface MutationState {
  revision: number;
  structureRevision: number;
  nonTailRevision: number;
  cellRevisions: number[];
  closes: number[];
  summary: IndicatorSeriesMutationSummary;
}

interface PriceMutationState {
  revision: number;
  structureRevision: number;
  nonTailRevision: number;
  times: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  summary: IndicatorSeriesMutationSummary;
}

const mutationStates = new WeakMap<FootprintSeries, MutationState>();
const priceMutationStates = new WeakMap<FootprintSeries, PriceMutationState>();

export function indicatorSeriesMutation(series: FootprintSeries): IndicatorSeriesMutationSummary {
  const cached = mutationStates.get(series);
  if (
    cached?.revision === series.revision
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
  ) {
    return cached.summary;
  }

  const bars = series.listReadonly();
  const tailIndex = bars.length - 1;
  const snapshot = (): MutationState => ({
    revision: series.revision,
    structureRevision: series.structureRevision,
    nonTailRevision: series.nonTailRevision,
    cellRevisions: bars.map((bar) => bar.cellRevision ?? 0),
    closes: bars.map((bar) => bar.close),
    summary: { kind: cached ? "structure" : "initial", revision: series.revision, structureRevision: series.structureRevision, tailIndex },
  });

  if (!cached || cached.structureRevision !== series.structureRevision || cached.cellRevisions.length !== bars.length) {
    const next = snapshot();
    mutationStates.set(series, next);
    return next.summary;
  }

  if (cached.nonTailRevision === series.nonTailRevision) {
    if (tailIndex < 0) {
      cached.revision = series.revision;
      cached.structureRevision = series.structureRevision;
      cached.nonTailRevision = series.nonTailRevision;
      cached.summary = { kind: "metadata", revision: series.revision, structureRevision: series.structureRevision, tailIndex };
      return cached.summary;
    }
    const tail = bars[tailIndex];
    const cellRevision = tail.cellRevision ?? 0;
    const changed = cellRevision !== cached.cellRevisions[tailIndex] || tail.close !== cached.closes[tailIndex];
    if (changed) {
      cached.cellRevisions[tailIndex] = cellRevision;
      cached.closes[tailIndex] = tail.close;
    }
    cached.revision = series.revision;
    cached.structureRevision = series.structureRevision;
    cached.nonTailRevision = series.nonTailRevision;
    cached.summary = {
      kind: changed ? "tail" : "metadata",
      revision: series.revision,
      structureRevision: series.structureRevision,
      tailIndex,
    };
    return cached.summary;
  }

  let changedIndex = -1;
  let multiple = false;
  for (let i = 0; i < bars.length; i++) {
    const cellRevision = bars[i].cellRevision ?? 0;
    const close = bars[i].close;
    if (cellRevision !== cached.cellRevisions[i] || close !== cached.closes[i]) {
      if (changedIndex >= 0 && changedIndex !== i) multiple = true;
      changedIndex = i;
    }
    cached.cellRevisions[i] = cellRevision;
    cached.closes[i] = close;
  }

  const kind: IndicatorSeriesMutationKind = changedIndex < 0
    ? "metadata"
    : !multiple && changedIndex === tailIndex
      ? "tail"
      : "non-tail";
  cached.revision = series.revision;
  cached.structureRevision = series.structureRevision;
  cached.nonTailRevision = series.nonTailRevision;
  cached.summary = { kind, revision: series.revision, structureRevision: series.structureRevision, tailIndex };
  return cached.summary;
}

/**
 * Mutation summary for indicators whose inputs are only time + OHLCV.
 *
 * Footprint/history enrichment may replace bar objects and bump structureRevision
 * without changing any price input. In that case price indicators can safely reuse
 * their prepared state, while footprint-sensitive indicators keep using the stricter
 * indicatorSeriesMutation() summary above.
 */
export function indicatorPriceSeriesMutation(series: FootprintSeries): IndicatorSeriesMutationSummary {
  const cached = priceMutationStates.get(series);
  if (
    cached?.revision === series.revision
    && cached.structureRevision === series.structureRevision
    && cached.nonTailRevision === series.nonTailRevision
  ) {
    return cached.summary;
  }

  const bars = series.listReadonly();
  const tailIndex = bars.length - 1;
  const makeSnapshot = (kind: IndicatorSeriesMutationKind): PriceMutationState => ({
    revision: series.revision,
    structureRevision: series.structureRevision,
    nonTailRevision: series.nonTailRevision,
    times: bars.map((bar) => bar.startTime),
    open: bars.map((bar) => bar.open),
    high: bars.map((bar) => bar.high),
    low: bars.map((bar) => bar.low),
    close: bars.map((bar) => bar.close),
    volume: bars.map((bar) => bar.volume),
    summary: { kind, revision: series.revision, structureRevision: series.structureRevision, tailIndex },
  });

  if (!cached) {
    const next = makeSnapshot("initial");
    priceMutationStates.set(series, next);
    return next.summary;
  }

  if (cached.times.length !== bars.length) {
    const next = makeSnapshot("structure");
    priceMutationStates.set(series, next);
    return next.summary;
  }

  if (cached.structureRevision === series.structureRevision && cached.nonTailRevision === series.nonTailRevision) {
    if (tailIndex < 0) {
      cached.revision = series.revision;
      cached.structureRevision = series.structureRevision;
      cached.nonTailRevision = series.nonTailRevision;
      cached.summary = { kind: "metadata", revision: series.revision, structureRevision: series.structureRevision, tailIndex };
      return cached.summary;
    }
    const bar = bars[tailIndex];
    if (bar.startTime !== cached.times[tailIndex]) {
      const next = makeSnapshot("structure");
      priceMutationStates.set(series, next);
      return next.summary;
    }
    const tailChanged = bar.open !== cached.open[tailIndex]
      || bar.high !== cached.high[tailIndex]
      || bar.low !== cached.low[tailIndex]
      || bar.close !== cached.close[tailIndex]
      || bar.volume !== cached.volume[tailIndex];
    if (tailChanged) {
      cached.open[tailIndex] = bar.open;
      cached.high[tailIndex] = bar.high;
      cached.low[tailIndex] = bar.low;
      cached.close[tailIndex] = bar.close;
      cached.volume[tailIndex] = bar.volume;
    }
    cached.revision = series.revision;
    cached.structureRevision = series.structureRevision;
    cached.nonTailRevision = series.nonTailRevision;
    cached.summary = {
      kind: tailChanged ? "tail" : "metadata",
      revision: series.revision,
      structureRevision: series.structureRevision,
      tailIndex,
    };
    return cached.summary;
  }

  let changedIndex = -1;
  let multiple = false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.startTime !== cached.times[i]) {
      const next = makeSnapshot("structure");
      priceMutationStates.set(series, next);
      return next.summary;
    }
    const changed = bar.open !== cached.open[i]
      || bar.high !== cached.high[i]
      || bar.low !== cached.low[i]
      || bar.close !== cached.close[i]
      || bar.volume !== cached.volume[i];
    if (changed) {
      if (changedIndex >= 0 && changedIndex !== i) multiple = true;
      changedIndex = i;
    }
    cached.open[i] = bar.open;
    cached.high[i] = bar.high;
    cached.low[i] = bar.low;
    cached.close[i] = bar.close;
    cached.volume[i] = bar.volume;
  }

  const kind: IndicatorSeriesMutationKind = changedIndex < 0
    ? "metadata"
    : !multiple && changedIndex === tailIndex
      ? "tail"
      : "non-tail";
  cached.revision = series.revision;
  cached.structureRevision = series.structureRevision;
  cached.nonTailRevision = series.nonTailRevision;
  cached.summary = { kind, revision: series.revision, structureRevision: series.structureRevision, tailIndex };
  return cached.summary;
}
