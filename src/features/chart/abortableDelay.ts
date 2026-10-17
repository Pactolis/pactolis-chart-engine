/**
 * Waits `ms`, or stops early when `signal` aborts. Resolves true when the full delay
 * elapsed and false when it was cut short; an abort clears the timer, so a disposed chart
 * leaves no pending timeout (and nothing it captured) behind.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
