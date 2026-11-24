import { incrementPerformanceCounter } from "../performanceTelemetry.js";

export type InteractionQualityPhase = "idle" | "interacting" | "settling";
export type InteractionQualityLevel = "full" | "reduced";

export interface InteractionQualityPolicy {
  readonly enabled: boolean;
  readonly pinnedFullQuality: boolean;
  readonly enterVelocityPxPerSec: number;
  readonly enterFrameBudgetMs: number;
  readonly hysteresisFrames: number;
  readonly settleDelayMs: number;
  readonly maxReducedDurationMs: number;
}

export interface InteractionQualityMotionSample {
  readonly velocityPxPerSec?: number;
  readonly frameMs?: number;
  readonly now?: number;
}

export interface InteractionQualitySnapshot {
  readonly phase: InteractionQualityPhase;
  readonly qualityLevel: InteractionQualityLevel;
  readonly generation: number;
  readonly suppressDenseFootprintText: boolean;
  readonly deferNonCriticalProfileDetail: boolean;
  readonly preserveCoreElements: true;
}

export interface InteractionQualityControllerOptions {
  readonly policy?: Partial<InteractionQualityPolicy>;
  readonly onSettleFullQuality?: (generation: number) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  readonly now?: () => number;
}

export const DEFAULT_INTERACTION_QUALITY_POLICY: InteractionQualityPolicy = {
  enabled: false,
  pinnedFullQuality: false,
  enterVelocityPxPerSec: 900,
  enterFrameBudgetMs: 18,
  hysteresisFrames: 3,
  settleDelayMs: 120,
  maxReducedDurationMs: 1500,
};

function normalizePositiveNumber(value: number | undefined, fallback: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function resolvePolicy(
  base: InteractionQualityPolicy,
  patch?: Partial<InteractionQualityPolicy>,
): InteractionQualityPolicy {
  if (!patch) return base;
  return {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : base.enabled,
    pinnedFullQuality: patch.pinnedFullQuality !== undefined ? Boolean(patch.pinnedFullQuality) : base.pinnedFullQuality,
    enterVelocityPxPerSec: normalizePositiveNumber(patch.enterVelocityPxPerSec, base.enterVelocityPxPerSec, 0),
    enterFrameBudgetMs: normalizePositiveNumber(patch.enterFrameBudgetMs, base.enterFrameBudgetMs, 0),
    hysteresisFrames: Math.max(1, Math.floor(normalizePositiveNumber(patch.hysteresisFrames, base.hysteresisFrames, 1))),
    settleDelayMs: normalizePositiveNumber(patch.settleDelayMs, base.settleDelayMs, 0),
    maxReducedDurationMs: normalizePositiveNumber(patch.maxReducedDurationMs, base.maxReducedDurationMs, 0),
  };
}

/**
 * Pure presentation-only pan/zoom adaptive quality state machine.
 *
 * Strictly governs non-critical presentation hints (such as dense footprint cell text
 * suppression during sustained fast motion) and deterministically settles back to full
 * quality. Never skips trade, OHLCV, footprint bin, POC/VAH/VAL, indicator, or alarm math.
 */
export class InteractionQualityController {
  private policy: InteractionQualityPolicy;
  private readonly onSettleFullQuality?: (generation: number) => void;
  private readonly settleListeners = new Set<(generation: number) => void>();
  private readonly setTimerFn: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimerFn: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly nowFn: () => number;

  private phase: InteractionQualityPhase = "idle";
  private qualityLevel: InteractionQualityLevel = "full";
  private generation = 0;
  private consecutiveHeavyFrames = 0;
  private reducedEnteredAtMs: number | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxReducedTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: InteractionQualityControllerOptions = {}) {
    this.policy = resolvePolicy(DEFAULT_INTERACTION_QUALITY_POLICY, options.policy);
    this.onSettleFullQuality = options.onSettleFullQuality;
    this.setTimerFn = options.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimerFn = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
    this.nowFn = options.now ?? (() => Date.now());
  }

  getPolicy(): InteractionQualityPolicy {
    return this.policy;
  }

  setPolicy(patch: Partial<InteractionQualityPolicy>): void {
    this.policy = resolvePolicy(this.policy, patch);
    if (!this.canUseReducedQuality() && this.qualityLevel === "reduced") {
      const currentGeneration = this.generation;
      this.clearTimers();
      this.resetToFullIdle();
      this.notifySettle(currentGeneration);
    }
  }

  onSettle(listener: (generation: number) => void): () => void {
    this.settleListeners.add(listener);
    return () => {
      this.settleListeners.delete(listener);
    };
  }

  beginInteraction(): InteractionQualitySnapshot {
    if (this.disposed) return this.getSnapshot();
    this.clearSettleTimer();
    if (this.phase === "idle") {
      this.consecutiveHeavyFrames = 0;
    }
    this.phase = "interacting";
    return this.getSnapshot();
  }

  noteMotion(sample: InteractionQualityMotionSample = {}): InteractionQualitySnapshot {
    if (this.disposed || !this.canUseReducedQuality()) {
      return this.getSnapshot();
    }

    this.clearSettleTimer();
    if (this.phase !== "interacting") {
      this.phase = "interacting";
    }

    const now = typeof sample.now === "number" && Number.isFinite(sample.now)
      ? sample.now
      : this.nowFn();

    if (this.qualityLevel === "reduced") {
      if (
        this.reducedEnteredAtMs !== null
        && this.policy.maxReducedDurationMs > 0
        && now - this.reducedEnteredAtMs >= this.policy.maxReducedDurationMs
      ) {
        this.settleNow(this.generation);
      }
      return this.getSnapshot();
    }

    const velocityExceeded = typeof sample.velocityPxPerSec === "number"
      && Number.isFinite(sample.velocityPxPerSec)
      && sample.velocityPxPerSec >= this.policy.enterVelocityPxPerSec;
    const frameBudgetExceeded = typeof sample.frameMs === "number"
      && Number.isFinite(sample.frameMs)
      && sample.frameMs >= this.policy.enterFrameBudgetMs;

    if (velocityExceeded || frameBudgetExceeded) {
      this.consecutiveHeavyFrames += 1;
      if (this.consecutiveHeavyFrames >= this.policy.hysteresisFrames) {
        this.enterReducedQuality(now);
      }
    } else {
      this.consecutiveHeavyFrames = 0;
    }

    return this.getSnapshot();
  }

  endInteraction(): InteractionQualitySnapshot {
    if (this.disposed || this.phase === "idle") {
      return this.getSnapshot();
    }

    if (this.qualityLevel === "full") {
      this.clearTimers();
      this.resetToFullIdle();
      return this.getSnapshot();
    }

    this.phase = "settling";
    this.scheduleSettleTimer();
    return this.getSnapshot();
  }

  cancel(): void {
    this.clearTimers();
    this.resetToFullIdle();
  }

  bumpGeneration(): number {
    this.generation += 1;
    this.clearTimers();
    this.resetToFullIdle();
    return this.generation;
  }

  getSnapshot(): InteractionQualitySnapshot {
    const reduced = this.qualityLevel === "reduced" && this.canUseReducedQuality() && !this.disposed;
    return {
      phase: this.phase,
      qualityLevel: reduced ? "reduced" : "full",
      generation: this.generation,
      suppressDenseFootprintText: reduced,
      deferNonCriticalProfileDetail: reduced,
      preserveCoreElements: true,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.resetToFullIdle();
    this.settleListeners.clear();
  }

  private canUseReducedQuality(): boolean {
    return this.policy.enabled && !this.policy.pinnedFullQuality;
  }

  private enterReducedQuality(now: number): void {
    this.qualityLevel = "reduced";
    this.reducedEnteredAtMs = now;
    incrementPerformanceCounter("chart.interactionQuality.enteredReduced");
    this.scheduleMaxReducedTimer();
  }

  private scheduleSettleTimer(): void {
    this.clearSettleTimer();
    const scheduledGeneration = this.generation;
    this.settleTimer = this.setTimerFn(() => {
      this.settleTimer = null;
      this.completeSettle(scheduledGeneration);
    }, this.policy.settleDelayMs);
  }

  private scheduleMaxReducedTimer(): void {
    this.clearMaxReducedTimer();
    if (this.policy.maxReducedDurationMs <= 0) return;
    const scheduledGeneration = this.generation;
    this.maxReducedTimer = this.setTimerFn(() => {
      this.maxReducedTimer = null;
      this.completeSettle(scheduledGeneration);
    }, this.policy.maxReducedDurationMs);
  }

  private completeSettle(scheduledGeneration: number): void {
    if (this.disposed || scheduledGeneration !== this.generation) {
      incrementPerformanceCounter("chart.interactionQuality.staleIgnored");
      return;
    }
    if (this.qualityLevel !== "reduced" && this.phase !== "settling") {
      return;
    }
    this.settleNow(scheduledGeneration);
  }

  private settleNow(scheduledGeneration: number): void {
    this.clearTimers();
    this.resetToFullIdle();
    incrementPerformanceCounter("chart.interactionQuality.settledFull");
    this.notifySettle(scheduledGeneration);
  }

  private notifySettle(generation: number): void {
    this.onSettleFullQuality?.(generation);
    for (const listener of this.settleListeners) {
      listener(generation);
    }
  }

  private resetToFullIdle(): void {
    this.phase = "idle";
    this.qualityLevel = "full";
    this.consecutiveHeavyFrames = 0;
    this.reducedEnteredAtMs = null;
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      this.clearTimerFn(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearMaxReducedTimer(): void {
    if (this.maxReducedTimer !== null) {
      this.clearTimerFn(this.maxReducedTimer);
      this.maxReducedTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSettleTimer();
    this.clearMaxReducedTimer();
  }
}
