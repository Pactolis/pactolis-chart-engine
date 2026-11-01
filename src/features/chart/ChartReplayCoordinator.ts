import { ChartChange, chartChangeForDataUpdate } from "../../core/render/scene/chartScene.js";
import type { ChartReplayServices } from "./ChartServicePorts.js";
import type { FootprintBar } from "../../core/types.js";
import { classifyReplayStepUpdate, makeDataUpdateEvent, snapshotFromSeries } from "../../core/dataUpdateEvent.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { ChartSession } from "./ChartSession.js";
import type { TimeScaleViewportController } from "../controllers/timeScaleViewportController.js";
import { ReplayController, cloneFootprintBarForReplay, type ReplaySnapshot } from "../replay/replayController.js";

export { cloneFootprintBarForReplay };

export interface ChartReplayCoordinatorHost {
  readonly pipeline: ChartDataPipeline;
  readonly session: ChartSession;
  readonly timeViewport: TimeScaleViewportController;
  readonly svc: ChartReplayServices;
  isDisposed(): boolean;
  getMarket(): string;
  autoFit(): void;
  updateHook(): void;
  loadHistory(): Promise<void>;
}

/**
 * Owns the per-chart replay state machine while ChartRuntime remains the public facade.
 * All replay-local mutable state and fan-out lives here so history/render code only asks
 * whether replay is active and requests a reconfiguration when the timeframe changes.
 */
export class ChartReplayCoordinator {
  private replay: ReplayController | null = null;
  /** Market the replay dataset was taken from; replay bars never land on another market's series. */
  private replayMarket: string | null = null;
  private applyingExternal = false;
  private readonly listeners = new Set<(snapshot: ReplaySnapshot | null) => void>();
  onStateChange?: (snapshot: ReplaySnapshot | null) => void;

  constructor(private readonly host: ChartReplayCoordinatorHost) {}

  isActive(): boolean { return this.replay !== null; }
  isSelecting(): boolean { return this.replay?.snapshot().state === "selecting"; }
  getSnapshot(): ReplaySnapshot | null { return this.replay?.snapshot() ?? null; }

  subscribe(cb: (snapshot: ReplaySnapshot | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.host.isDisposed() || this.replay) return;
    const series = this.host.pipeline.series;
    const bars: FootprintBar[] = [];
    for (let index = 0; index < series.length; index++) {
      const bar = series.at(index);
      if (bar) bars.push(cloneFootprintBarForReplay(bar));
    }
    if (bars.length === 0) return;

    this.host.pipeline.setPaused(true);
    const market = this.host.getMarket();
    this.replayMarket = market;
    const controller: ReplayController = new ReplayController(
      (bar) => {
        if (this.replay !== controller) return;
        if (this.host.getMarket() !== market) {
          this.exit({ reloadHistory: false });
          return;
        }
        this.appendBars([bar]);
      },
      (snapshot) => {
        // A controller that was exited mid-step still finishes that step; its state is gone.
        if (this.replay !== controller) return;
        this.emit(snapshot);
        this.host.updateHook();
      },
    );
    this.replay = controller;
    this.replay.loadForSelection(bars, this.host.pipeline.intervalMs);
  }

  /** The chart left the replayed market: drop the replay without reloading; the new market loads its own history. */
  exitForMarketChange(market: string): void {
    if (this.replay && this.replayMarket !== market) this.exit({ reloadHistory: false });
  }

  play(): void { this.replay?.play(); }
  pause(): void { this.replay?.pause(); }
  step(): void { this.replay?.step(); }
  setSpeed(speed: number): void { this.replay?.setSpeed(speed); }

  seek(time: number): void {
    if (!this.replay) return;
    this.replaceSeries(this.replay.seek(time));
  }

  selectFirst(): void {
    const snapshot = this.replay?.snapshot();
    if (snapshot) this.seek(snapshot.rangeStart);
  }

  selectRandom(): void {
    if (this.replay) this.seek(this.replay.randomTime());
  }

  exit(options: { reloadHistory?: boolean } = {}): void {
    const replay = this.replay;
    if (!replay) return;
    // Detach first: the controller's final "idle" snapshot is not a replay state to
    // relay; linked charts would read it as a clock to follow and re-enter replay.
    this.replay = null;
    this.replayMarket = null;
    replay.exit();
    this.emit(null);
    this.host.updateHook();
    this.host.pipeline.setPaused(false);
    if (options.reloadHistory !== false) {
      this.host.loadHistory().catch((error: unknown) => {
        console.warn("[chart.replay] history reload after replay failed", error);
      });
    }
  }

  applyExternal(snapshot: ReplaySnapshot | null): void {
    if (this.host.isDisposed()) return;
    this.applyingExternal = true;
    try {
      if (snapshot == null) {
        this.exit();
        return;
      }
      if (!this.replay) this.start();
      if (!this.replay || snapshot.state === "selecting") return;
      this.setSpeed(snapshot.speed);
      // The source chart owns the group's clock: follow it without a timer of our own,
      // and append only the bars it completed instead of rebuilding the series.
      const result = this.replay.follow(snapshot.virtualTime, snapshot.state === "playing");
      if ("append" in result) this.appendBars(result.append);
      else this.replaceSeries(result.replace);
    } finally {
      this.applyingExternal = false;
    }
  }

  /**
   * Take over the replay clock when this chart follows a playing owner that is gone
   * (closed or moved to another link group). The chart then plays on its own timer
   * and, while it stays linked, becomes the clock its peers follow.
   */
  adoptClock(): void {
    const replay = this.replay;
    if (!replay || this.host.isDisposed() || replay.isTicking()) return;
    if (replay.snapshot().state === "playing") replay.play();
  }

  reconfigureAfterTimeframeChange(intervalMs: number): void {
    if (!this.replay) return;
    const bars: FootprintBar[] = [];
    const series = this.host.pipeline.series;
    for (let index = 0; index < series.length; index++) {
      const bar = series.at(index);
      if (bar) bars.push(cloneFootprintBarForReplay(bar));
    }
    const result = this.replay.reconfigure(bars, intervalMs);
    this.replaceSeries(result.visibleBars);
    if (result.resume) this.replay.play();
  }

  dispose(): void {
    // dispose(), not exit(): the host is already torn down at this point (see
    // ChartRuntime.dispose), so we must not run exit()'s emit -> host.updateHook()
    // side effect. dispose() only guarantees the interval timer is cleared.
    if (this.replay) this.replay.dispose();
    this.replay = null;
    this.replayMarket = null;
    this.listeners.clear();
    this.onStateChange = undefined;
  }

  private appendBars(bars: FootprintBar[]): void {
    if (bars.length === 0) return;
    const series = this.host.pipeline.series;
    const previous = snapshotFromSeries(series);
    for (const bar of bars) series.upsertBar(bar);
    const next = snapshotFromSeries(series);
    const kind = classifyReplayStepUpdate(previous, next);
    this.host.timeViewport.applyDataUpdate(makeDataUpdateEvent(kind, "replay", previous, next));
    this.host.autoFit();
    this.host.session.invalidate(chartChangeForDataUpdate(kind) | ChartChange.Viewport);
  }

  private replaceSeries(visibleBars: FootprintBar[]): void {
    const series = this.host.pipeline.series;
    series.clear();
    for (const bar of visibleBars) series.upsertBar(bar);
    this.host.timeViewport.placeReplayPrefixEnd(series.length);
    this.host.svc.updateAnalysisFromSeries(this.host.getMarket(), series, series.config.priceStep);
    this.host.autoFit();
    this.host.session.invalidate(ChartChange.DataNonTail | ChartChange.Viewport);
  }

  private emit(snapshot: ReplaySnapshot | null): void {
    this.onStateChange?.(snapshot);
    if (this.applyingExternal) return;
    for (const listener of this.listeners) listener(snapshot);
  }
}
