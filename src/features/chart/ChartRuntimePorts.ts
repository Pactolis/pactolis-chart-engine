import type { ChartPanelState, LinkGroupColor } from "../../core/chartPanelState.js";
import type { ReplaySnapshot } from "../replay/replayController.js";
import type { ChartCaptureReadiness } from "./captureReadiness.js";
import type { NativeChartCapture } from "./nativeCapture.js";

/**
 * Narrow capability contracts exposed by ChartRuntime.
 *
 * These ports intentionally contain no implementation details. Platform consumers
 * should depend on the smallest port they need instead of importing the full
 * ChartRuntime implementation module. ChartRuntime remains the facade while its
 * internal capabilities are extracted incrementally behind these contracts.
 */
export interface ChartRuntimeStatePort {
  getState(): ChartPanelState;
}

export interface ChartReplayPort extends ChartRuntimeStatePort {
  startReplay(): void;
  replayPlay(): void;
  replayPause(): void;
  replayStep(): void;
  replaySetSpeed(speed: number): void;
  replaySeek(time: number): void;
  replaySelectFirst(): void;
  replaySelectRandom(): void;
  exitReplay(): void;
  getReplaySnapshot(): ReplaySnapshot | null;
  subscribeReplayState(cb: (snapshot: ReplaySnapshot | null) => void): () => void;
  applyExternalReplay(snapshot: ReplaySnapshot | null): void;
  onReplayState?: (snapshot: ReplaySnapshot | null) => void;
}

export interface ChartSyncPort extends ChartRuntimeStatePort {
  getVisibleTimeRange(): { from: number; to: number } | null;
  setVisibleTimeRange(range: { from: number; to: number }): void;
  subscribeVisibleRangeChange(cb: (range: { from: number; to: number }) => void): () => void;
  subscribeCrosshairMove(cb: (event: { time: number | null; price: number | null }) => void): () => void;
  subscribeTimeframeChange(cb: (timeframe: string) => void): () => void;
  subscribeMarketChange(cb: (market: string) => void): () => void;
  subscribeReplayState(cb: (snapshot: ReplaySnapshot | null) => void): () => void;
  showSyncCrosshair(time: number): void;
  hideSyncCrosshair(): void;
  applyExternalTimeframe(timeframe: string): void;
  applyExternalMarket(market: string): void;
  applyExternalReplay(snapshot: ReplaySnapshot | null): void;
  /** Start playing on this chart's own timer if it follows a playing clock owner that is gone. */
  adoptReplayClock(): void;
  setLinkGroup(color: LinkGroupColor | null): void;
  subscribeLinkGroupChange(cb: (previous: LinkGroupColor | undefined) => void): () => void;
}

export interface ChartCapturePort extends ChartRuntimeStatePort {
  getCaptureReadiness(): ChartCaptureReadiness;
  subscribeCaptureReadiness(cb: (snapshot: ChartCaptureReadiness) => void): () => void;
  captureNativePng(): Promise<NativeChartCapture>;
}
