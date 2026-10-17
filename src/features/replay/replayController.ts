import type { FootprintBar } from "../../core/types.js";

export type ReplayState = "idle" | "selecting" | "paused" | "playing" | "done";

export interface ReplaySnapshot {
  state: ReplayState;
  virtualTime: number;
  speed: number;
  visibleBars: number;
  totalBars: number;
  rangeStart: number;
  rangeEnd: number;
}

/**
 * Upper bound on bars released from a single tick() call. Browsers throttle
 * background-tab timers to >=1s, so tick() can see a multi-second (or, after a
 * long backgrounding, multi-minute) wall-clock jump on the first tick after the
 * tab regains focus. Without a cap, `pendingBars` would drain in one synchronous
 * `while` loop, releasing hundreds of bars — and firing hundreds of state emits
 * (see MAX_BARS_PER_TICK usage in tick()) — inside a single frame. The cap spreads
 * that catch-up across multiple 50ms ticks instead; no bar is ever dropped, it
 * just takes a few extra ticks to fully catch up rather than one synchronous
 * burst. In the normal foreground case pendingBars rarely exceeds 1 between
 * ticks, so this never engages and speed semantics are unchanged.
 */
const MAX_BARS_PER_TICK = 20;

export class ReplayController {
  private bars: FootprintBar[] = [];
  private cursor = 0;
  private timer: number | null = null;
  private lastTick = 0;
  private state: ReplayState = "idle";
  /** Completed bars released per real second. */
  private speed = 1;
  private pendingBars = 0;
  private virtualTime = 0;
  private intervalMs = 60_000;

  constructor(
    private readonly onBar: (bar: FootprintBar) => void,
    private readonly onState: (snapshot: ReplaySnapshot) => void
  ) {}

  load(bars: FootprintBar[], cursor = 0, intervalMs = this.intervalMs): void {
    this.stopTimer();
    this.bars = bars;
    this.intervalMs = Math.max(1, intervalMs);
    this.cursor = Math.max(0, Math.min(cursor, this.bars.length));
    this.virtualTime = this.bars[this.cursor]?.startTime ?? this.bars[this.bars.length - 1]?.startTime ?? 0;
    this.state = "paused";
    this.emit();
  }

  loadForSelection(bars: FootprintBar[], intervalMs: number): void {
    this.stopTimer();
    this.bars = bars;
    this.intervalMs = Math.max(1, intervalMs);
    this.cursor = this.bars.length;
    this.virtualTime = this.rangeEnd();
    this.state = "selecting";
    this.emit();
  }

  /**
   * Replace the timeframe dataset without resetting the replay clock.
   * Only bars completed at virtualTime are returned for immediate rendering.
   */
  reconfigure(bars: FootprintBar[], intervalMs: number): { visibleBars: FootprintBar[]; resume: boolean } {
    const resume = this.state === "playing";
    this.stopTimer();
    this.bars = bars;
    this.intervalMs = Math.max(1, intervalMs);
    this.cursor = 0;
    while (
      this.cursor < this.bars.length
      && this.bars[this.cursor].startTime + this.intervalMs <= this.virtualTime
    ) {
      this.cursor++;
    }
    this.state = this.cursor >= this.bars.length ? "done" : "paused";
    this.emit();
    return { visibleBars: this.bars.slice(0, this.cursor), resume };
  }

  /** Move the replay clock and return the completed bars at the destination. */
  seek(time: number): FootprintBar[] {
    this.stopTimer();
    this.moveClock(time);
    this.state = this.cursor >= this.bars.length ? "done" : "paused";
    this.emit();
    return this.bars.slice(0, this.cursor);
  }

  /**
   * Follow a linked chart's replay clock. The clock owner's timer is the only one
   * that advances a link group; a follower never runs its own, so `playing` only
   * mirrors the owner's state. When the clock moved forward from a non-selecting
   * state, only the newly completed bars are returned to append; otherwise the
   * full completed prefix is returned to replace the series.
   */
  follow(time: number, playing: boolean): { append: FootprintBar[] } | { replace: FootprintBar[] } {
    this.stopTimer();
    const wasSelecting = this.state === "selecting";
    const previousCursor = this.cursor;
    this.moveClock(time);
    this.state = this.cursor >= this.bars.length ? "done" : playing ? "playing" : "paused";
    this.emit();
    return !wasSelecting && this.cursor >= previousCursor
      ? { append: this.bars.slice(previousCursor, this.cursor) }
      : { replace: this.bars.slice(0, this.cursor) };
  }

  /** True while this controller's own timer drives the clock. */
  isTicking(): boolean {
    return this.timer !== null;
  }

  randomTime(): number {
    if (this.bars.length === 0) return 0;
    const index = Math.floor(Math.random() * this.bars.length);
    return this.bars[index].startTime + this.intervalMs;
  }

  play(): void {
    if (!this.bars.length || this.state === "selecting" || this.state === "done") return;
    this.state = "playing";
    this.lastTick = performance.now();
    this.stopTimer();
    this.timer = window.setInterval(() => this.tick(), 50);
    this.emit();
  }

  pause(): void {
    this.stopTimer();
    if (this.state !== "idle" && this.state !== "selecting") this.state = "paused";
    this.emit();
  }

  step(): void {
    if (this.state === "selecting") return;
    this.pause();
    this.releaseNext();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, speed);
    this.emit();
  }

  exit(): void {
    this.stopTimer();
    this.bars = [];
    this.cursor = 0;
    this.state = "idle";
    this.emit();
  }

  /**
   * Explicit teardown contract for whoever constructs this controller (see
   * ChartReplayCoordinator). Unlike exit(), which represents the user leaving
   * replay mode and emits a final state snapshot, dispose() performs no state
   * transition or emit — it only guarantees stopTimer() runs so a controller
   * that is simply dropped cannot leak its interval. Safe to call multiple
   * times, and safe to call instead of or after exit().
   */
  dispose(): void {
    this.stopTimer();
  }

  snapshot(): ReplaySnapshot {
    return {
      state: this.state,
      virtualTime: this.virtualTime,
      speed: this.speed,
      visibleBars: this.cursor,
      totalBars: this.bars.length,
      rangeStart: this.rangeStart(),
      rangeEnd: this.rangeEnd(),
    };
  }

  private rangeStart(): number {
    return this.bars[0]?.startTime ?? 0;
  }

  private rangeEnd(): number {
    const last = this.bars[this.bars.length - 1];
    return last ? last.startTime + this.intervalMs : 0;
  }

  private moveClock(time: number): void {
    this.virtualTime = Math.max(this.rangeStart(), Math.min(time, this.rangeEnd()));
    this.cursor = 0;
    while (
      this.cursor < this.bars.length
      && this.bars[this.cursor].startTime + this.intervalMs <= this.virtualTime
    ) {
      this.cursor++;
    }
  }

  private tick(): void {
    const now = performance.now();
    this.pendingBars += (now - this.lastTick) * this.speed / 1000;
    this.lastTick = now;
    // Release bars without emitting per-bar (releaseOne), bounding how many a
    // single tick can drain (see MAX_BARS_PER_TICK). One batched emit at the end
    // reflects the final state, whether that's a normal single-bar tick or a
    // capped catch-up burst after the tab was backgrounded.
    let released = 0;
    while (released < MAX_BARS_PER_TICK && this.pendingBars >= 1 && this.cursor < this.bars.length) {
      this.pendingBars -= 1;
      released++;
      if (!this.releaseOne()) break;
    }
    if (released > 0) this.emit();
  }

  /** Single user-driven step (the Step button): unlike tick()'s batching, this always emits. */
  private releaseNext(): void {
    this.releaseOne();
    this.emit();
  }

  /** Releases the next bar, if any. Returns false once the controller has reached "done". */
  private releaseOne(): boolean {
    const bar = this.bars[this.cursor++];
    if (!bar) {
      this.stopTimer();
      this.state = "done";
      return false;
    }
    this.virtualTime = Math.max(this.virtualTime, bar.startTime + this.intervalMs);
    this.onBar(bar);
    if (this.cursor >= this.bars.length) {
      this.stopTimer();
      this.state = "done";
      return false;
    }
    return true;
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.pendingBars = 0;
  }

  private emit(): void {
    this.onState(this.snapshot());
  }
}
