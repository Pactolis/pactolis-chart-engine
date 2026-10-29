import { View } from "../../core/engine/view.js";
import type { ChartDataUpdateEvent } from "../../core/dataUpdateEvent.js";

export interface TimeScaleViewportState {
  readonly followLatest: boolean;
  readonly lastDataLength: number;
}

/**
 * DIAG-0424 (TEMPORARY): Trace helper for horizontal viewport placement.
 * Enabled via globalThis.__vpTrace = true, logged to console.
 * Zero cost when disabled (early return).
 */
export function traceViewport(msg: string): void {
  if (!(globalThis as unknown as { __vpTrace?: boolean }).__vpTrace) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [vp] ${msg}`);
}

interface PlotPanGesture {
  readonly startOffsetX: number;
}

interface TimeAxisScaleGesture {
  readonly startX: number;
  readonly startColWidth: number;
  readonly startOffsetX: number;
}

/**
 * Owns horizontal viewport policy for a chart panel.
 *
 * Runtime and renderers should not decide whether live data moves the chart.
 * They report intent here: data updated, user changed viewport, explicit reset,
 * resize, replay step, or explicit range focus.
 */
export class TimeScaleViewportController {
  private readonly view: View;
  private _followLatest = true;
  private _lastDataLength = 0;
  private _latestPlacementPending = false;
  /** Deferred placement flavor: plain latest scroll, initial 250-fit, or explicit reset fit. */
  private _pendingPlacement: "latest" | "initial-fit" | "reset" | null = null;
  /** True until the first history-driven 250-column fit (or a guarded short-history fit). */
  private _initialFitPending = true;
  /**
   * Right offset (in bars) the user chose by zooming while live-follow stayed on.
   * Later latest placements (new bar, history patch, resize) keep this gap instead of snapping the latest bar back
   * to the default padding. null means the default `latestBarRightPaddingBars`.
   */
  private _followRightOffsetBars: number | null = null;
  /** Bumped on every user-owned pan/zoom commit, so a history load can tell the user moved during it. */
  private _userViewportRevision = 0;
  private _plotPanGesture: PlotPanGesture | null = null;
  private _timeAxisScaleGesture: TimeAxisScaleGesture | null = null;

  constructor(view: View) {
    this.view = view;
  }

  /**
   * DIAG-0424 (TEMPORARY): Set followLatest and log state changes.
   * Logs only when value actually changes to avoid spam.
   */
  private _setFollowLatest(next: boolean, reason: string): void {
    if (this._followLatest === next) return;
    const prev = this._followLatest;
    this._followLatest = next;
    traceViewport(`follow ${prev}→${next} reason=${reason}`);
  }

  state(): TimeScaleViewportState {
    return {
      followLatest: this._followLatest,
      lastDataLength: this._lastDataLength,
    };
  }

  followsLatest(): boolean {
    return this._followLatest;
  }

  /** Changes whenever the user pans or zooms; compare two reads to detect a move in between. */
  userViewportRevision(): number {
    return this._userViewportRevision;
  }

  /** User-driven horizontal pan/zoom/axis-scale makes the viewport user-owned. */
  markUserViewportChange(total: number): void {
    this._commitUserViewportChange(total);
  }

  /** Keep internal data-length tracking current without moving the viewport. */
  observeDataLength(total: number): void {
    this._lastDataLength = Math.max(0, total);
  }

  /** Keep an absolute-time bar at its pre-patch canvas coordinate after its logical index changes. */
  /**
   * On a timeframe change, preserve the absolute time window only for a
   * user-owned historical viewport. A live-follow viewport has no historical
   * time anchor to preserve; scaling 1m's default 84 px spacing by 240 on a
   * 1m→4h switch hit the 400 px ceiling and left a single candle on screen.
   * Keeping its spacing stable preserves the useful live bar count instead.
   */
  rescaleForIntervalChange(oldIntervalMs: number, newIntervalMs: number): void {
    if (this._followLatest) return;
    this.view.rescaleColWidthForInterval(oldIntervalMs, newIntervalMs);
  }

  restoreTimeAnchor(anchorX: number, nextIndex: number): boolean {
    if (!Number.isFinite(anchorX) || !Number.isFinite(nextIndex) || nextIndex < 0) return false;
    this.view.offsetX += anchorX - this.view.xOfIndex(nextIndex);
    return true;
  }

  /** Apply wheel/trackpad horizontal panning. Runtime supplies input intent; this controller owns viewport mutation. */
  applyWheelPan(deltaPx: number, total: number): boolean {
    this.view.panX(-deltaPx);
    return this._commitUserViewportChange(total);
  }

  /** Apply wheel/trackpad horizontal zoom around an explicit canvas x coordinate. */
  applyWheelZoom(factor: number, anchorX: number, total: number): boolean {
    this.view.zoomX(factor, anchorX);
    return this._commitZoomViewportChange(total);
  }

  /** Start a plot-area horizontal pan gesture. */
  beginPlotPan(): void {
    this._plotPanGesture = { startOffsetX: this.view.offsetX };
  }

  /** Continue a plot-area horizontal pan gesture using the original pointer-down snapshot. */
  dragPlotPanTo(deltaPx: number, total: number): boolean {
    if (this._plotPanGesture === null) return false;
    this.view.offsetX = this._plotPanGesture.startOffsetX + deltaPx;
    return this._commitUserViewportChange(total);
  }

  /** Finish a plot-area horizontal pan gesture. */
  endPlotPan(): void {
    this._plotPanGesture = null;
  }

  /** Start a time-axis scale gesture. Gesture snapshots live here, not in ChartRuntime. */
  beginTimeAxisScale(startX: number): void {
    this._timeAxisScaleGesture = {
      startX,
      startColWidth: this.view.colWidth,
      startOffsetX: this.view.offsetX,
    };
  }

  /** Continue a time-axis scale gesture; spacing follows the pointer's distance from the plot's right edge. */
  dragTimeAxisScaleTo(currentX: number, total: number): boolean {
    const gesture = this._timeAxisScaleGesture;
    if (gesture === null) return false;
    this.view.scaleTimeAxisTo(gesture.startX, currentX, gesture.startColWidth, gesture.startOffsetX);
    // Time-axis drag is a scale (zoom), not a pan — keep live-follow when the latest
    // bar stays in view, same as wheel zoom (#1).
    return this._commitZoomViewportChange(total);
  }

  /** Finish a time-axis scale gesture. */
  endTimeAxisScale(): void {
    this._timeAxisScaleGesture = null;
  }

  /** Explicit time-scale reset: fit min(total, defaultFitColumns) columns (250 unless the host lowered it) with reset padding. */
  resetToDefault(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._setFollowLatest(true, "reset-default");
    this._followRightOffsetBars = null;
    this._lastDataLength = nextTotal;
    if (nextTotal > 0 && this.view.area.width > 1) {
      this._initialFitPending = false;
      const beforeOffsetX = this.view.offsetX;
      this.view.resetTimeScale(nextTotal, this.view.timeScaleOptions.resetRightPaddingBars);
      const afterOffsetX = this.view.offsetX;
      const delta = Math.round(afterOffsetX - beforeOffsetX);
      traceViewport(`RESET_TIMESCALE offsetX ${Math.round(beforeOffsetX)}→${Math.round(afterOffsetX)} Δ=${delta}px`);
      this._latestPlacementPending = false;
      this._pendingPlacement = null;
    } else if (nextTotal > 0) {
      this._initialFitPending = false;
      this._latestPlacementPending = true;
      this._pendingPlacement = "reset";
    } else {
      // An empty reset re-arms the initial-history fit policy instead of
      // suppressing the first real history fit.
      this._initialFitPending = true;
      this._latestPlacementPending = false;
      this._pendingPlacement = null;
    }
    return nextTotal > 0;
  }

  /** Explicit history/load reset: place at latest, fitting 250 columns once ready. */
  placeLatestAfterDataReset(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._setFollowLatest(true, "history-loaded");
    this._followRightOffsetBars = null;
    this._lastDataLength = nextTotal;
    if (this._initialFitPending && nextTotal >= this.view.timeScaleOptions.defaultFitColumns) {
      return this._applyInitialFit(nextTotal, "history-loaded");
    }
    this._latestPlacementPending = nextTotal > 0;
    return this._placeLatest(nextTotal, "data-reset");
  }

  /**
   * History (re)load that must not take the viewport away from the user: a load the
   * user panned or zoomed during, or a background refresh. A live-follow viewport
   * stays on the latest bar with the right offset its zoom left; a user-owned
   * historical viewport is not moved.
   */
  keepViewportAfterHistoryLoad(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._lastDataLength = nextTotal;
    if (nextTotal <= 0 || !this._followLatest) return false;
    return this._placeLatest(nextTotal, "history-kept");
  }

  /**
   * Guarded history-completion readiness (Settings/250): after the real history
   * load settles, fit N = min(total, 250) columns once. A history of at least
   * 250 bars fits a constant 250 columns without final-marker ambiguity; a
   * short settled history fits its actual N. Deferred when geometry is missing.
   */
  completeInitialHistoryFit(total: number): boolean {
    const nextTotal = Math.max(0, total);
    if (!this._initialFitPending || nextTotal <= 0) return false;
    return this._applyInitialFit(nextTotal, "history-settled");
  }

  private _applyInitialFit(total: number, reason: string): boolean {
    if (this.view.area.width <= 1) {
      this._latestPlacementPending = true;
      // A deferred fit is not consumed: keep initial-fit armed until valid
      // geometry lets the fit actually run, and never downgrade an explicit
      // reset flavor.
      if (this._pendingPlacement === null || this._pendingPlacement === "latest") {
        this._pendingPlacement = "initial-fit";
      }
      traceViewport(`INITIAL_FIT reason=${reason} total=${total} deferred (areaW=${Math.round(this.view.area.width)})`);
      return false;
    }
    this._initialFitPending = false;
    this.view.resetTimeScale(total, this.view.timeScaleOptions.latestBarRightPaddingBars);
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    traceViewport(`INITIAL_FIT reason=${reason} total=${total} spacing=${this.view.colWidth.toFixed(3)}`);
    return true;
  }

  /** Explicit latest navigation: preserve current spacing and re-enter live-follow. */
  goLatest(total: number): boolean {
    this._setFollowLatest(true, "go-latest");
    this._followRightOffsetBars = null;
    this._initialFitPending = false;
    this._lastDataLength = Math.max(0, total);
    this._latestPlacementPending = total > 0;
    // Explicit latest navigation wins over any stale deferred placement flavor
    // (initial-fit/reset armed while hidden); a deferred rerun must scroll, not re-fit.
    this._pendingPlacement = null;
    return this._placeLatest(total, "go-latest");
  }

  /** Explicit focus operation that shows the end of the focused range without entering live-follow. */
  placeFocusedRangeEnd(total: number): boolean {
    this._setFollowLatest(false, "focused-range-end");
    this._followRightOffsetBars = null;
    this._initialFitPending = false;
    this._lastDataLength = Math.max(0, total);
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    return this._placeLatest(total, "focused-range-end");
  }

  /** Replace a replay prefix without resetting the user's horizontal zoom. */
  placeReplayPrefixEnd(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._setFollowLatest(true, "replay-prefix");
    this._followRightOffsetBars = null;
    this._initialFitPending = false;
    this._lastDataLength = nextTotal;
    this._latestPlacementPending = nextTotal > 0;
    this._pendingPlacement = null;
    this._plotPanGesture = null;
    this._timeAxisScaleGesture = null;
    return this._placeLatest(nextTotal, "replay-prefix");
  }

  /** Replay is an explicit synthetic stream; by default, replay follows appended bars. */
  resetForReplay(): void {
    this._setFollowLatest(true, "replay-reset");
    this._followRightOffsetBars = null;
    this._initialFitPending = false;
    this._lastDataLength = 0;
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    this._plotPanGesture = null;
    this._timeAxisScaleGesture = null;
  }

  /**
   * Data update policy.
   *
   * The controller does not infer update semantics from raw series length.
   * ChartDataPipeline classifies the data mutation first (history load, same-bar
   * live update, new-bar append, metadata repaint, etc.), and the time-scale
   * policy decides whether horizontal viewport placement is allowed.
   */
  applyDataUpdate(event: ChartDataUpdateEvent, options: { preserveViewport?: boolean } = {}): boolean {
    const nextTotal = Math.max(0, event.next.length);
    const previousTotal = Math.max(0, event.previous.length);
    this._lastDataLength = nextTotal;
    traceViewport(`update kind=${event.kind} prev=${previousTotal} next=${nextTotal} follow=${this._followLatest}`);

    switch (event.kind) {
      case "history-loaded":
        return options.preserveViewport
          ? this.keepViewportAfterHistoryLoad(nextTotal)
          : this.placeLatestAfterDataReset(nextTotal);
      case "price-step-reset":
        this._setFollowLatest(true, "price-step-reset");
        return false;
      case "replay-reset":
        this.resetForReplay();
        return false;
      case "series-cleared":
      case "metadata-updated":
      case "same-bar-update":
        return false;
      case "history-patched":
        if (this._initialFitPending && this._followLatest && nextTotal >= this.view.timeScaleOptions.defaultFitColumns) {
          return this._applyInitialFit(nextTotal, "history-patched");
        }
        return this._followLatest && nextTotal > 0 ? this._placeLatest(nextTotal, "history-patched") : false;
      case "new-bar-appended":
      case "replay-step":
        if (nextTotal <= 0 || !this._followLatest) return false;
        if (previousTotal <= 0) return this._placeLatest(nextTotal, event.kind);
        if (!this.view.timeScaleOptions.shiftVisibleRangeOnNewBar) return false;
        if (!this._isLatestVisible(previousTotal)) return false;
        return this._placeLatest(nextTotal, event.kind);
      default: {
        const exhaustive: never = event.kind;
        return exhaustive;
      }
    }
  }

  /** Resize should only restore latest placement when the viewport is still latest-owned. */
  applyResize(total: number, reason: string): boolean {
    const nextTotal = Math.max(0, total);
    this._lastDataLength = nextTotal;
    traceViewport(
      `resize reason=${reason} total=${nextTotal} follow=${this._followLatest} areaW=${Math.round(this.view.area.width)}`,
    );
    const spacingChanged = this.view.enforceMinimumBarSpacing();
    if (nextTotal <= 0) return spacingChanged;
    if (!this._followLatest) {
      if (spacingChanged) this.view.clampOffsetX(nextTotal);
      return spacingChanged;
    }
    if (this._latestPlacementPending) {
      // A deferred placement (initial fit or explicit reset) still owns the
      // horizontal policy; ensurePendingLatestPlacement applies it with its
      // own padding mode instead of a plain latest scroll on resize.
      return spacingChanged;
    }
    return this._placeLatest(nextTotal, "resize");
  }

  /** Complete a deferred placement once chart geometry exists, keeping its padding mode. */
  ensurePendingLatestPlacement(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._lastDataLength = nextTotal;
    if (nextTotal <= 0 || !this._followLatest || !this._latestPlacementPending) return false;
    if (this.view.area.width <= 1) return false;
    const mode = this._pendingPlacement;
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    if (mode === "initial-fit") {
      // The deferred fit has now actually run with valid geometry; consume it
      // so a later history-patched/history-settled update cannot re-fit over
      // an ordinary resize that preserved the fitted spacing.
      this._initialFitPending = false;
      this.view.resetTimeScale(nextTotal, this.view.timeScaleOptions.latestBarRightPaddingBars);
      traceViewport(`PENDING_PLACEMENT mode=initial-fit total=${nextTotal}`);
      return true;
    }
    if (mode === "reset") {
      this.view.resetTimeScale(nextTotal, this.view.timeScaleOptions.resetRightPaddingBars);
      traceViewport(`PENDING_PLACEMENT mode=reset total=${nextTotal}`);
      return true;
    }
    return this._placeLatest(nextTotal, "pending-placement");
  }

  private _commitUserViewportChange(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._userViewportRevision++;
    this._setFollowLatest(false, "user-viewport-change");
    this._followRightOffsetBars = null;
    this._initialFitPending = false;
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    this._lastDataLength = nextTotal;
    this.view.clampOffsetX(nextTotal);
    return true;
  }

  /**
   * Commit a zoom (scale-only) change. Unlike a pan, zooming does not express intent to
   * leave the live edge: charting-tool convention is that zooming while the latest bar is
   * still in view keeps live-follow on, so the right edge doesn't freeze mid-session
   * (reported: every wheel-zoom silently stopped live tracking). Panning still drops
   * follow because it is an explicit move away from the edge.
   *
   * Zoom may therefore keep or drop live-follow, but must never re-acquire it: a
   * user-owned historical viewport that happens to bring the latest bar back into view
   * is still user-owned. Re-acquiring it re-armed the 20s OHLC re-assert timer into a
   * right-edge snap after every zoom on a viewport the user had panned away from
   * (TASK-425, measured via __vpTrace).
   */
  private _commitZoomViewportChange(total: number): boolean {
    const nextTotal = Math.max(0, total);
    this._userViewportRevision++;
    this._initialFitPending = false;
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    this._lastDataLength = nextTotal;
    this.view.clampOffsetX(nextTotal);
    if (this._followLatest) this._setFollowLatest(this._isLatestVisible(nextTotal), "zoom-latest-visibility");
    // Remember where the zoom left the latest bar so the next live placement
    // does not pull it back to the right edge (zoom-out "snap to right").
    this._followRightOffsetBars = this._followLatest && nextTotal > 0 ? this._latestRightOffsetBars(nextTotal) : null;
    return true;
  }

  private _latestRightOffsetBars(total: number): number {
    const plotRight = this.view.area.left + this.view.area.width;
    return Math.max(0, (plotRight - this.view.xOfIndex(total - 1)) / this.view.colWidth);
  }

  private _isLatestVisible(total: number): boolean {
    if (total <= 0 || this.view.area.width <= 1) return false;
    const x = this.view.xOfIndex(total - 1);
    return x >= this.view.area.left && x <= this.view.area.left + this.view.area.width;
  }

  private _placeLatest(total: number, reason: string): boolean {
    if (total <= 0) {
      this._latestPlacementPending = false;
      return false;
    }
    if (this.view.area.width <= 1) {
      this._latestPlacementPending = true;
      // Preserve an already-pending fit flavor (initial-fit/reset) across
      // wrapper repeats while hidden; only a bare latest scroll defaults.
      if (this._pendingPlacement === null) this._pendingPlacement = "latest";
      traceViewport(`PLACE_LATEST reason=${reason} deferred (areaW=${Math.round(this.view.area.width)})`);
      return false;
    }
    const beforeOffsetX = this.view.offsetX;
    this.view.scrollToIndex(
      total - 1,
      this._followRightOffsetBars ?? this.view.timeScaleOptions.latestBarRightPaddingBars,
    );
    const afterOffsetX = this.view.offsetX;
    const delta = afterOffsetX - beforeOffsetX;
    const deltaText = Math.abs(delta) < 0.5 ? "Δ=0 (no-op)" : `Δ=${Math.round(delta)}px`;
    traceViewport(
      `PLACE_LATEST reason=${reason} offsetX ${Math.round(beforeOffsetX)}→${Math.round(afterOffsetX)} ${deltaText}`
      + ` colWidth=${this.view.colWidth.toFixed(2)} total=${total} areaW=${Math.round(this.view.area.width)}`,
    );
    this._latestPlacementPending = false;
    this._pendingPlacement = null;
    return true;
  }
}
