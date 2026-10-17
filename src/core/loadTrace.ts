const traceStarts = new Map<string, number>();
let sequence = 0;

export function isLoadTraceEnabled(): boolean {
  if (typeof location === "undefined") return false;
  try { return new URLSearchParams(location.search).get("loadTrace") === "1"; }
  catch { return false; }
}

export function createLoadTrace(market: string, interval: number): string | undefined {
  if (!isLoadTraceEnabled()) return undefined;
  const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  traceStarts.set(id, performance.now());
  logLoadTrace(id, "load.start", { market, interval });
  return id;
}

export function logLoadTrace(traceId: string | undefined, stage: string, fields: Record<string, unknown> = {}): void {
  if (!traceId || !isLoadTraceEnabled()) return;
  const startedAt = traceStarts.get(traceId) ?? performance.now();
  if (!traceStarts.has(traceId)) traceStarts.set(traceId, startedAt);
  console.info(`[load-trace] ${stage}`, { traceId, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100, ...fields });
}

export function finishLoadTrace(traceId: string | undefined, fields: Record<string, unknown> = {}): void {
  if (!traceId) return;
  logLoadTrace(traceId, "load.complete", fields);
  while (traceStarts.size > 100) traceStarts.delete(traceStarts.keys().next().value!);
}
