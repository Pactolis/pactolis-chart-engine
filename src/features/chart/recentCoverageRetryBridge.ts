import type { LiveRepairRetryReason } from "./recentCoverageRetryPolicy.js";

type ScheduledRetry = () => boolean;
type RetryScheduler = (attempt: number, retry: ScheduledRetry, reason: LiveRepairRetryReason) => void;

const schedulers = new WeakMap<object, RetryScheduler>();

/** Bind one pipeline reconnect repair to the chart history retry timer owner. */
export function registerRecentCoverageRetryScheduler(
  owner: object,
  scheduler: RetryScheduler,
): () => void {
  schedulers.set(owner, scheduler);
  return () => {
    if (schedulers.get(owner) === scheduler) schedulers.delete(owner);
  };
}

/** Queue reconnect repair through the already-existing recent-coverage scheduler. */
export function requestRecentCoverageRetry(
  owner: object,
  attempt: number,
  retry: ScheduledRetry,
  reason: LiveRepairRetryReason = "transport",
): boolean {
  const scheduler = schedulers.get(owner);
  if (!scheduler) return false;
  scheduler(attempt, retry, reason);
  return true;
}
