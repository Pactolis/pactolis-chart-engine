export interface LoadTraceContext {
  readonly chartId?: string;
  readonly market?: string;
  readonly timeframe?: string;
  readonly chartType?: string;
  readonly generation?: number;
  readonly reason?: string;
}

const traceStarts = new Map<string, number>();
const traceContexts = new Map<string, LoadTraceContext>();
let sequence = 0;

function compactContext(context: LoadTraceContext | undefined): Record<string, unknown> {
  if (!context) return {};
  const fields: Record<string, unknown> = {};
  if (context.chartId !== undefined) fields.chartId = context.chartId;
  if (context.market !== undefined) fields.market = context.market;
  if (context.timeframe !== undefined) fields.timeframe = context.timeframe;
  if (context.chartType !== undefined) fields.chartType = context.chartType;
  if (context.generation !== undefined) fields.generation = context.generation;
  if (context.reason !== undefined) fields.reason = context.reason;
  return fields;
}

export function isLoadTraceEnabled(): boolean {
  if (typeof location === "undefined") return false;
  try { return new URLSearchParams(location.search).get("loadTrace") === "1"; }
  catch { return false; }
}

export function createLoadTrace(market: string, interval: number, context?: LoadTraceContext): string | undefined {
  if (!isLoadTraceEnabled()) return undefined;
  const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  traceStarts.set(id, performance.now());
  if (context) traceContexts.set(id, context);
  logLoadTrace(id, "load.start", { market, interval });
  return id;
}

export function logLoadTrace(traceId: string | undefined, stage: string, fields: Record<string, unknown> = {}): void {
  if (!traceId || !isLoadTraceEnabled()) return;
  const startedAt = traceStarts.get(traceId) ?? performance.now();
  if (!traceStarts.has(traceId)) traceStarts.set(traceId, startedAt);
  const contextFields = compactContext(traceContexts.get(traceId));
  console.info(`[load-trace] ${stage}`, {
    traceId,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    ...contextFields,
    ...fields,
  });
}

export function finishLoadTrace(traceId: string | undefined, fields: Record<string, unknown> = {}): void {
  if (!traceId) return;
  logLoadTrace(traceId, "load.complete", fields);
  while (traceStarts.size > 100) {
    const oldest = traceStarts.keys().next().value!;
    traceStarts.delete(oldest);
    traceContexts.delete(oldest);
  }
}
