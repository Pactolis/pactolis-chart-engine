import { incrementPerformanceCounter } from "../../core/performanceTelemetry.js";

/**
 * Revision stamp that uniquely identifies the chart, series, range, and
 * indicator settings state for which a prepared indicator payload is valid.
 * Pure data contract with zero DOM dependencies so it can cross worker boundaries.
 */
export interface IndicatorPrepareRevisionStamp {
  readonly generation: number;
  readonly market: string;
  readonly timeframe: string;
  readonly intervalMs: number;
  readonly seriesRevision: number;
  readonly nonTailRevision: number;
  readonly resetEpoch: number;
  readonly settingsRevision: number;
  readonly rangeFrom: number;
  readonly rangeTo: number;
  readonly timeBucket?: number;
}

export interface IndicatorPrepareJobRequest<TContext = unknown> {
  readonly instanceId: string;
  readonly definitionType: string;
  readonly stamp: IndicatorPrepareRevisionStamp;
  readonly signal: AbortSignal;
  readonly context: TContext;
}

export type IndicatorPrepareRunner<TResult = unknown, TContext = unknown> = (
  request: IndicatorPrepareJobRequest<TContext>,
) => Promise<TResult> | TResult;

export type IndicatorPrepareScheduleStatus = "applied" | "stale" | "aborted" | "disposed";

export interface IndicatorPrepareScheduleResult<TResult> {
  readonly status: IndicatorPrepareScheduleStatus;
  readonly value?: TResult;
  readonly stamp: IndicatorPrepareRevisionStamp;
}

export interface IndicatorPrepareScheduleParams<TResult, TContext> {
  readonly instanceId: string;
  readonly definitionType: string;
  readonly stamp: IndicatorPrepareRevisionStamp;
  readonly context: TContext;
  readonly runner: IndicatorPrepareRunner<TResult, TContext>;
  readonly onApply?: (value: TResult, stamp: IndicatorPrepareRevisionStamp) => void;
}

const SKIPPED_EXECUTION = Symbol("indicator-prepare-skipped");

interface ActiveJobEntry<TResult> {
  readonly token: number;
  readonly definitionType: string;
  readonly stamp: IndicatorPrepareRevisionStamp;
  readonly controller: AbortController;
  readonly promise: Promise<IndicatorPrepareScheduleResult<TResult>>;
}

export function sameIndicatorPrepareRevisionStamp(
  a: IndicatorPrepareRevisionStamp | null | undefined,
  b: IndicatorPrepareRevisionStamp | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.generation === b.generation
    && a.market === b.market
    && a.timeframe === b.timeframe
    && a.intervalMs === b.intervalMs
    && a.seriesRevision === b.seriesRevision
    && a.nonTailRevision === b.nonTailRevision
    && a.resetEpoch === b.resetEpoch
    && a.settingsRevision === b.settingsRevision
    && a.rangeFrom === b.rangeFrom
    && a.rangeTo === b.rangeTo
    && (a.timeBucket ?? 0) === (b.timeBucket ?? 0);
}

/**
 * Verifies whether a candidate stamp is compatible with the expected stamp.
 * Returns false on cold-start (missing stamp) or any revision/identity mismatch.
 */
export function isCompatibleIndicatorPrepareRevisionStamp(
  expected: IndicatorPrepareRevisionStamp | null | undefined,
  candidate: IndicatorPrepareRevisionStamp | null | undefined,
): boolean {
  return sameIndicatorPrepareRevisionStamp(expected, candidate);
}

/**
 * Worker-ready, DOM-free scheduler that coordinates asynchronous or off-thread
 * indicator preparation without spawning per-indicator workers or pools.
 * Coalesces duplicate requests per instance, cancels superseded in-flight work
 * via AbortController, and drops stale completions against the latest expected stamp.
 */
export class IndicatorPrepareScheduler {
  private readonly activeJobs = new Map<string, ActiveJobEntry<unknown>>();
  private readonly expectedStamps = new Map<string, IndicatorPrepareRevisionStamp>();
  private nextToken = 1;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  getActiveCount(): number {
    return this.activeJobs.size;
  }

  hasPending(instanceId: string): boolean {
    return this.activeJobs.has(instanceId);
  }

  getExpectedStamp(instanceId: string): IndicatorPrepareRevisionStamp | undefined {
    return this.expectedStamps.get(instanceId);
  }

  /**
   * Updates the expected revision stamp for an instance without launching a job.
   * Any in-flight job with an older stamp will be dropped as stale on completion.
   */
  setExpectedStamp(instanceId: string, stamp: IndicatorPrepareRevisionStamp): void {
    if (this.disposed) return;
    this.expectedStamps.set(instanceId, stamp);
  }

  schedule<TResult, TContext>(
    params: IndicatorPrepareScheduleParams<TResult, TContext>,
  ): Promise<IndicatorPrepareScheduleResult<TResult>> {
    if (this.disposed) {
      return Promise.resolve({ status: "disposed", stamp: params.stamp });
    }

    const { instanceId, definitionType, stamp, context, runner, onApply } = params;
    const existing = this.activeJobs.get(instanceId) as ActiveJobEntry<TResult> | undefined;
    if (existing && !existing.controller.signal.aborted && sameIndicatorPrepareRevisionStamp(existing.stamp, stamp)) {
      return existing.promise;
    }

    if (existing) {
      existing.controller.abort();
    }

    this.expectedStamps.set(instanceId, stamp);
    const token = this.nextToken++;
    const controller = new AbortController();

    const promise = Promise.resolve()
      .then(() => {
        if (this.disposed || controller.signal.aborted || !this.isCurrentJob(instanceId, token, stamp)) {
          return SKIPPED_EXECUTION;
        }
        return runner({
          instanceId,
          definitionType,
          stamp,
          signal: controller.signal,
          context,
        });
      })
      .then((outcome): IndicatorPrepareScheduleResult<TResult> => {
        if (outcome === SKIPPED_EXECUTION) {
          return { status: this.disposed ? "disposed" : "aborted", stamp };
        }

        const current = this.activeJobs.get(instanceId);
        if (current?.token === token) {
          this.activeJobs.delete(instanceId);
        }

        if (this.disposed) {
          incrementPerformanceCounter(`indicator.prepare.staleDropped.${definitionType}`);
          return { status: "disposed", stamp };
        }

        const expected = this.expectedStamps.get(instanceId);
        const isCurrentToken = current?.token === token;
        const isCompatible = isCompatibleIndicatorPrepareRevisionStamp(expected, stamp);

        if (controller.signal.aborted || !isCurrentToken || !isCompatible) {
          incrementPerformanceCounter(`indicator.prepare.staleDropped.${definitionType}`);
          return { status: "stale", stamp };
        }

        onApply?.(outcome, stamp);
        return { status: "applied", value: outcome, stamp };
      })
      .catch((error: unknown): IndicatorPrepareScheduleResult<TResult> => {
        const current = this.activeJobs.get(instanceId);
        if (current?.token === token) {
          this.activeJobs.delete(instanceId);
        }
        if (this.disposed) {
          return { status: "disposed", stamp };
        }
        if (controller.signal.aborted || !this.isCurrentJob(instanceId, token, stamp)) {
          incrementPerformanceCounter(`indicator.prepare.staleDropped.${definitionType}`);
          return { status: "aborted", stamp };
        }
        throw error;
      });

    this.activeJobs.set(instanceId, {
      token,
      definitionType,
      stamp,
      controller,
      promise: promise as Promise<IndicatorPrepareScheduleResult<unknown>>,
    });

    return promise;
  }

  cancel(instanceId: string): void {
    const active = this.activeJobs.get(instanceId);
    if (active) {
      active.controller.abort();
      this.activeJobs.delete(instanceId);
    }
    this.expectedStamps.delete(instanceId);
  }

  cancelAll(): void {
    for (const active of this.activeJobs.values()) {
      active.controller.abort();
    }
    this.activeJobs.clear();
    this.expectedStamps.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
  }

  private isCurrentJob(instanceId: string, token: number, stamp: IndicatorPrepareRevisionStamp): boolean {
    if (this.disposed) return false;
    const active = this.activeJobs.get(instanceId);
    if (!active || active.token !== token) return false;
    return isCompatibleIndicatorPrepareRevisionStamp(this.expectedStamps.get(instanceId), stamp);
  }
}
