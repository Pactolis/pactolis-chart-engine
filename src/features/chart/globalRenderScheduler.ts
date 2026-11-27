import { incrementPerformanceCounter, recordPerformanceDuration } from "../../core/performanceTelemetry.js";

export type ChartRenderPriority = "active" | "visible" | "hidden";

export interface GlobalRenderSchedulerConfig {
  enabled: boolean;
  frameBudgetMs: number;
  maxStalenessMs: number;
}

export interface SchedulerWindow {
  requestAnimationFrame(callback: (timestamp: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface ScheduleRenderOptions {
  priority?: ChartRenderPriority;
  urgent?: boolean;
}

interface ScheduledEntry {
  token: object;
  callback: () => void;
  priority: ChartRenderPriority;
  urgent: boolean;
  enqueuedAt: number;
}

const DEFAULT_CONFIG: GlobalRenderSchedulerConfig = {
  enabled: false,
  frameBudgetMs: 10,
  maxStalenessMs: 100,
};

let globalConfig: GlobalRenderSchedulerConfig = { ...DEFAULT_CONFIG };

const windowSchedulers = new WeakMap<object, GlobalRenderScheduler>();

function defaultNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

export function configureGlobalRenderScheduler(
  next: Partial<GlobalRenderSchedulerConfig>,
): void {
  globalConfig = {
    enabled: next.enabled ?? globalConfig.enabled,
    frameBudgetMs:
      typeof next.frameBudgetMs === "number" && Number.isFinite(next.frameBudgetMs) && next.frameBudgetMs > 0
        ? next.frameBudgetMs
        : globalConfig.frameBudgetMs,
    maxStalenessMs:
      typeof next.maxStalenessMs === "number" && Number.isFinite(next.maxStalenessMs) && next.maxStalenessMs >= 0
        ? next.maxStalenessMs
        : globalConfig.maxStalenessMs,
  };
}

export function getGlobalRenderSchedulerConfig(): Readonly<GlobalRenderSchedulerConfig> {
  return globalConfig;
}

export function resetGlobalRenderSchedulerConfig(): void {
  globalConfig = { ...DEFAULT_CONFIG };
}

/**
 * Returns the isolated GlobalRenderScheduler bound to `win` (e.g., main window or popout).
 * Returns `null` when `win` is nullish.
 */
export function getGlobalRenderScheduler(
  win: SchedulerWindow | null | undefined,
): GlobalRenderScheduler | null {
  if (!win || typeof win !== "object") return null;
  let scheduler = windowSchedulers.get(win);
  if (!scheduler) {
    scheduler = new GlobalRenderScheduler(win);
    windowSchedulers.set(win, scheduler);
  }
  return scheduler;
}

/**
 * Per-window cooperative render scheduler for multi-chart layouts.
 *
 * Guarantees:
 * - Zero-idle RAF: never schedules `requestAnimationFrame` when the queue is empty.
 * - Coalescing: multiple requests for the same panel token before vsync collapse to 1 callback.
 * - Priority tiers: `urgent` > `active` > `visible` > `hidden`, with age-based anti-starvation
 *   promotion (`maxStalenessMs`) and round-robin fairness within tiers.
 */
export class GlobalRenderScheduler {
  private readonly win: SchedulerWindow;
  private readonly now: () => number;
  private readonly pending = new Map<object, ScheduledEntry>();
  private readonly priorities = new WeakMap<object, ChartRenderPriority>();
  private readonly starvedQueue: ScheduledEntry[] = [];
  private readonly urgentQueue: ScheduledEntry[] = [];
  private readonly activeQueue: ScheduledEntry[] = [];
  private readonly visibleQueue: ScheduledEntry[] = [];
  private readonly hiddenQueue: ScheduledEntry[] = [];
  private readonly orderedQueue: ScheduledEntry[] = [];
  private rafId: number | null = null;

  constructor(win: SchedulerWindow, now: () => number = defaultNow) {
    this.win = win;
    this.now = now;
  }

  setPriority(token: object, priority: ChartRenderPriority): void {
    this.priorities.set(token, priority);
    const entry = this.pending.get(token);
    if (entry) {
      entry.priority = priority;
    }
  }

  getPriority(token: object): ChartRenderPriority {
    return this.priorities.get(token) ?? "visible";
  }

  schedule(
    token: object,
    callback: () => void,
    options?: ScheduleRenderOptions,
  ): void {
    const priority = options?.priority ?? this.priorities.get(token) ?? "visible";
    this.priorities.set(token, priority);

    const existing = this.pending.get(token);
    if (existing) {
      existing.callback = callback;
      existing.priority = priority;
      if (options?.urgent) {
        existing.urgent = true;
      }
    } else {
      this.pending.set(token, {
        token,
        callback,
        priority,
        urgent: Boolean(options?.urgent),
        enqueuedAt: this.now(),
      });
    }

    this.ensureRafScheduled();
  }

  unregister(token: object): void {
    this.pending.delete(token);
    if (this.pending.size === 0 && this.rafId !== null) {
      this.win.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  hasPending(token: object): boolean {
    return this.pending.has(token);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  isRafScheduled(): boolean {
    return this.rafId !== null;
  }

  private ensureRafScheduled(): void {
    if (this.pending.size === 0 || this.rafId !== null) return;
    this.rafId = this.win.requestAnimationFrame(() => {
      this.rafId = null;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
    if (this.pending.size === 0) return;

    incrementPerformanceCounter("chart.scheduler.frames");

    const frameStart = this.now();
    const { frameBudgetMs, maxStalenessMs } = globalConfig;

    // Snapshot entries present at the start of this vsync turn into reusable queues;
    // re-entrant schedules during callbacks will be picked up by the successor RAF.
    const starvedQueue = this.starvedQueue;
    const urgentQueue = this.urgentQueue;
    const activeQueue = this.activeQueue;
    const visibleQueue = this.visibleQueue;
    const hiddenQueue = this.hiddenQueue;
    const ordered = this.orderedQueue;

    starvedQueue.length = 0;
    urgentQueue.length = 0;
    activeQueue.length = 0;
    visibleQueue.length = 0;
    hiddenQueue.length = 0;
    ordered.length = 0;

    for (const entry of this.pending.values()) {
      const age = frameStart - entry.enqueuedAt;
      if (entry.priority !== "active" && age >= maxStalenessMs) {
        incrementPerformanceCounter("chart.scheduler.starvationBoost");
        starvedQueue.push(entry);
        continue;
      }
      if (entry.urgent) {
        urgentQueue.push(entry);
        continue;
      }
      if (entry.priority === "active") {
        activeQueue.push(entry);
      } else if (entry.priority === "visible") {
        visibleQueue.push(entry);
      } else {
        hiddenQueue.push(entry);
      }
    }

    for (let i = 0; i < starvedQueue.length; i++) ordered.push(starvedQueue[i]);
    for (let i = 0; i < urgentQueue.length; i++) ordered.push(urgentQueue[i]);
    for (let i = 0; i < activeQueue.length; i++) ordered.push(activeQueue[i]);
    for (let i = 0; i < visibleQueue.length; i++) ordered.push(visibleQueue[i]);
    for (let i = 0; i < hiddenQueue.length; i++) ordered.push(hiddenQueue[i]);

    let executedCount = 0;

    try {
      for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        // Re-check membership in case an earlier callback unregistered this token.
        if (!this.pending.has(entry.token)) continue;

        // Bound every tier (including consecutive urgent callbacks) to the frame budget
        // after at least one entry has made progress in this frame.
        if (executedCount > 0 && this.now() - frameStart >= frameBudgetMs) {
          break;
        }

        // Remove before invoking so re-entrant schedule() appends to the back of Map
        // (preserving round-robin fairness) and throwing callbacks do not stick.
        this.pending.delete(entry.token);
        executedCount++;

        if (entry.urgent) {
          incrementPerformanceCounter("chart.scheduler.urgentFlush");
        }

        entry.callback();
      }
    } finally {
      const frameElapsedMs = this.now() - frameStart;
      recordPerformanceDuration("chart.scheduler.frame.ms", frameElapsedMs);
      if (frameElapsedMs > frameBudgetMs) {
        incrementPerformanceCounter("chart.scheduler.overbudgetFrames");
      }
      // Count entries from this frame's snapshot that were deferred due to budget.
      for (let i = 0; i < ordered.length; i++) {
        if (this.pending.has(ordered[i].token)) {
          incrementPerformanceCounter("chart.scheduler.deferred");
        }
      }
      starvedQueue.length = 0;
      urgentQueue.length = 0;
      activeQueue.length = 0;
      visibleQueue.length = 0;
      hiddenQueue.length = 0;
      ordered.length = 0;
      this.ensureRafScheduled();
    }
  }
}
