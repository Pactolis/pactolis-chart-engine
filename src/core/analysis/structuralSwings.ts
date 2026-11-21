import type { SwingBar, SwingPivot } from "./swings.js";

/** Bar input for structural swings and market-structure break analysis. */
export interface StructureBar extends SwingBar {
  close?: number;
  open?: number;
  startTime?: number;
}

export type SwingKind = "high" | "low";
export type StructuralSwingStatus = "provisional" | "finalized";
export type StructuralSwingLabel = "H" | "L" | "HH" | "LH" | "HL" | "LL" | "EQH" | "EQL";
export type MarketStructureTrend = "unknown" | "bullish" | "bearish" | "transition";
export type BreakConfirmationMode = "close" | "wick";
export type StructureBreakKind = "BOS" | "CHoCH";
export type StructureDirection = "bullish" | "bearish";

export interface StructuralSwing {
  pivotIndex: number;
  confirmedAtIndex: number;
  structuralFinalizedAtIndex: number | null;
  price: number;
  kind: SwingKind;
  status: StructuralSwingStatus;
  label: StructuralSwingLabel;
}

/**
 * Recorded when a single bar forms both a raw swing high and a raw swing low.
 * Because intra-bar OHLC execution order cannot be known from a bar summary,
 * neither side is promoted into a synthetic intra-bar high->low or low->high pair.
 */
export interface AmbiguousDualPivot {
  index: number;
  confirmedAtIndex: number;
  highPrice: number;
  lowPrice: number;
  resolution: "excluded-ambiguous";
}

export interface StructureBreakEvent {
  kind: StructureBreakKind;
  direction: StructureDirection;
  confirmation: BreakConfirmationMode;
  levelPrice: number;
  pivotIndex: number;
  pivotConfirmedAtIndex: number;
  breakIndex: number;
  ambiguousSameBarBreak?: boolean;
}

export interface ProtectedLevel {
  kind: SwingKind;
  price: number;
  pivotIndex: number;
  confirmedAtIndex: number;
  activatedAtIndex: number;
  brokenAtIndex: number | null;
  supersededAtIndex: number | null;
  status: "active" | "broken" | "superseded";
}

export interface SweepCandidate {
  kind: SwingKind;
  levelPrice: number;
  pivotIndex: number;
  pivotConfirmedAtIndex: number;
  barIndex: number;
  wickPrice: number;
  closePrice: number;
}

export interface StructuralSwingUpdate {
  activeSwing: StructuralSwing | null;
  finalizedSwing: StructuralSwing | null;
  replacedProvisional: boolean;
  supersededSwing: StructuralSwing | null;
  ambiguousDualPivot: AmbiguousDualPivot | null;
}

export interface StructuralSwingResolution {
  swings: StructuralSwing[];
  ambiguousDualPivots: AmbiguousDualPivot[];
}

export interface MarketStructureOptions {
  left: number;
  right: number;
  equalityTolerance?: number;
  breakConfirmation?: BreakConfirmationMode;
}

export interface MarketStructureSnapshot {
  swings: readonly StructuralSwing[];
  ambiguousDualPivots: readonly AmbiguousDualPivot[];
  breakEvents: readonly StructureBreakEvent[];
  protectedLevels: readonly ProtectedLevel[];
  sweepCandidates: readonly SweepCandidate[];
  trend: MarketStructureTrend;
  activeProtectedLow: ProtectedLevel | null;
  activeProtectedHigh: ProtectedLevel | null;
  activeSwingHigh: StructuralSwing | null;
  activeSwingLow: StructuralSwing | null;
}

function sanitizeTolerance(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function classifyStructuralSwing(
  kind: SwingKind,
  price: number,
  prevPrice: number | undefined,
  tolerance: number,
): StructuralSwingLabel {
  if (prevPrice === undefined) return kind === "high" ? "H" : "L";
  if (Math.abs(price - prevPrice) <= tolerance) return kind === "high" ? "EQH" : "EQL";
  if (kind === "high") return price > prevPrice ? "HH" : "LH";
  return price > prevPrice ? "HL" : "LL";
}

/**
 * Deterministic alternating swing filter (`high -> low -> high -> low`).
 *
 * - Consecutive candidates of the same kind replace the trailing provisional swing
 *   only when strictly more extreme beyond `equalityTolerance` (ties retain the first).
 * - An opposite-kind confirmed pivot locks/finalizes the previous provisional swing
 *   permanently (`structuralFinalizedAtIndex = pivot.confirmedAtIndex`).
 * - A bar that confirms both a raw high and raw low simultaneously is recorded as
 *   `ambiguousDualPivot` and excluded rather than inventing intra-bar ordering.
 */
export class StructuralSwingResolver {
  private readonly equalityTolerance: number;
  private swings: StructuralSwing[] = [];
  private ambiguousDualPivots: AmbiguousDualPivot[] = [];

  constructor(equalityTolerance = 0) {
    this.equalityTolerance = sanitizeTolerance(equalityTolerance);
  }

  reset(): void {
    this.swings = [];
    this.ambiguousDualPivots = [];
  }

  getSwings(): readonly StructuralSwing[] {
    return this.swings;
  }

  getAmbiguousDualPivots(): readonly AmbiguousDualPivot[] {
    return this.ambiguousDualPivots;
  }

  /** Consumes all raw pivots confirmed at the exact same bar (`confirmedAtIndex`). */
  pushConfirmedAt(pivotsAtBar: readonly SwingPivot[]): StructuralSwingUpdate {
    if (pivotsAtBar.length === 0) {
      return {
        activeSwing: null,
        finalizedSwing: null,
        replacedProvisional: false,
        supersededSwing: null,
        ambiguousDualPivot: null,
      };
    }

    if (pivotsAtBar.length >= 2) {
      let highPivot: SwingPivot | undefined;
      let lowPivot: SwingPivot | undefined;
      for (const pivot of pivotsAtBar) {
        if (pivot.kind === "high") highPivot = pivot;
        else lowPivot = pivot;
      }
      if (highPivot && lowPivot) {
        const ambiguous: AmbiguousDualPivot = {
          index: highPivot.index,
          confirmedAtIndex: highPivot.confirmedAtIndex,
          highPrice: highPivot.price,
          lowPrice: lowPivot.price,
          resolution: "excluded-ambiguous",
        };
        this.ambiguousDualPivots.push(ambiguous);
        return {
          activeSwing: null,
          finalizedSwing: null,
          replacedProvisional: false,
          supersededSwing: null,
          ambiguousDualPivot: ambiguous,
        };
      }
    }

    const pivot = pivotsAtBar[0];
    const last = this.swings[this.swings.length - 1];
    if (!last) {
      const firstSwing: StructuralSwing = {
        pivotIndex: pivot.index,
        confirmedAtIndex: pivot.confirmedAtIndex,
        structuralFinalizedAtIndex: null,
        price: pivot.price,
        kind: pivot.kind,
        status: "provisional",
        label: pivot.kind === "high" ? "H" : "L",
      };
      this.swings.push(firstSwing);
      return {
        activeSwing: firstSwing,
        finalizedSwing: null,
        replacedProvisional: false,
        supersededSwing: null,
        ambiguousDualPivot: null,
      };
    }

    if (last.kind === pivot.kind) {
      const moreExtreme = pivot.kind === "high"
        ? pivot.price > last.price + this.equalityTolerance
        : pivot.price < last.price - this.equalityTolerance;
      if (!moreExtreme) {
        return {
          activeSwing: null,
          finalizedSwing: null,
          replacedProvisional: false,
          supersededSwing: null,
          ambiguousDualPivot: null,
        };
      }
      const prevSameKind = this.swings.length >= 3 ? this.swings[this.swings.length - 3] : undefined;
      const next: StructuralSwing = {
        pivotIndex: pivot.index,
        confirmedAtIndex: pivot.confirmedAtIndex,
        structuralFinalizedAtIndex: null,
        price: pivot.price,
        kind: pivot.kind,
        status: "provisional",
        label: classifyStructuralSwing(pivot.kind, pivot.price, prevSameKind?.price, this.equalityTolerance),
      };
      this.swings[this.swings.length - 1] = next;
      return {
        activeSwing: next,
        finalizedSwing: null,
        replacedProvisional: true,
        supersededSwing: last,
        ambiguousDualPivot: null,
      };
    }

    const finalized: StructuralSwing = {
      ...last,
      status: "finalized",
      structuralFinalizedAtIndex: pivot.confirmedAtIndex,
    };
    this.swings[this.swings.length - 1] = finalized;

    const prevSameKind = this.swings.length >= 2 ? this.swings[this.swings.length - 2] : undefined;
    const next: StructuralSwing = {
      pivotIndex: pivot.index,
      confirmedAtIndex: pivot.confirmedAtIndex,
      structuralFinalizedAtIndex: null,
      price: pivot.price,
      kind: pivot.kind,
      status: "provisional",
      label: classifyStructuralSwing(pivot.kind, pivot.price, prevSameKind?.price, this.equalityTolerance),
    };
    this.swings.push(next);
    return {
      activeSwing: next,
      finalizedSwing: finalized,
      replacedProvisional: false,
      supersededSwing: null,
      ambiguousDualPivot: null,
    };
  }
}

/** Pure one-shot structural swing resolution from confirmed raw pivots. */
export function resolveStructuralSwings(
  pivots: readonly SwingPivot[],
  equalityTolerance = 0,
): StructuralSwingResolution {
  const resolver = new StructuralSwingResolver(equalityTolerance);
  let i = 0;
  while (i < pivots.length) {
    const confirmedAt = pivots[i].confirmedAtIndex;
    const pivotIndex = pivots[i].index;
    let end = i + 1;
    while (end < pivots.length && pivots[end].confirmedAtIndex === confirmedAt && pivots[end].index === pivotIndex) {
      end++;
    }
    resolver.pushConfirmedAt(pivots.slice(i, end));
    i = end;
  }
  return {
    swings: [...resolver.getSwings()],
    ambiguousDualPivots: [...resolver.getAmbiguousDualPivots()],
  };
}

function barClose(bar: StructureBar): number {
  return typeof bar.close === "number" && Number.isFinite(bar.close) ? bar.close : (bar.high + bar.low) * 0.5;
}

function checkBreakAbove(
  bar: StructureBar,
  levelPrice: number,
  tolerance: number,
  mode: BreakConfirmationMode,
): "break" | "sweep" | null {
  const threshold = levelPrice + tolerance;
  const close = barClose(bar);
  if (mode === "wick") {
    return Number.isFinite(bar.high) && bar.high > threshold ? "break" : null;
  }
  if (Number.isFinite(close) && close > threshold) return "break";
  if (Number.isFinite(bar.high) && bar.high > threshold) return "sweep";
  return null;
}

function checkBreakBelow(
  bar: StructureBar,
  levelPrice: number,
  tolerance: number,
  mode: BreakConfirmationMode,
): "break" | "sweep" | null {
  const threshold = levelPrice - tolerance;
  const close = barClose(bar);
  if (mode === "wick") {
    return Number.isFinite(bar.low) && bar.low < threshold ? "break" : null;
  }
  if (Number.isFinite(close) && close < threshold) return "break";
  if (Number.isFinite(bar.low) && bar.low < threshold) return "sweep";
  return null;
}

/**
 * Causal Market Structure state machine (`unknown | bullish | bearish | transition`).
 *
 * - Trend starts `unknown`; initial structure requires `HH + HL` (bullish) or `LL + LH` (bearish)
 *   before any BOS/CHoCH can fire.
 * - `protectedLow` (bullish) and `protectedHigh` (bearish) promote deterministically only when
 *   a BOS confirms that the pullback swing drove a new structural break; minor pullbacks do not
 *   trigger trend reversals.
 * - Breaking a protected level fires CHoCH and enters `transition`, suppressing subsequent BOS
 *   signals until post-CHoCH structural swings confirm the new direction.
 */
export class MarketStructureEngine {
  private readonly equalityTolerance: number;
  private readonly breakConfirmation: BreakConfirmationMode;
  private readonly resolver: StructuralSwingResolver;
  private trend: MarketStructureTrend = "unknown";
  private transitionTarget: StructureDirection | null = null;
  private transitionStartedAtIndex = -1;
  private transitionBrokenLevelPrice = 0;
  private transitionCounterPrice = 0;
  private activeProtectedLow: ProtectedLevel | null = null;
  private activeProtectedHigh: ProtectedLevel | null = null;
  private activeSwingHigh: StructuralSwing | null = null;
  private activeSwingLow: StructuralSwing | null = null;
  private candidatePullbackLow: StructuralSwing | null = null;
  private candidatePullbackHigh: StructuralSwing | null = null;
  private highestConfirmedHighInBullish: StructuralSwing | null = null;
  private lowestConfirmedLowInBearish: StructuralSwing | null = null;
  private breakEvents: StructureBreakEvent[] = [];
  private protectedLevels: ProtectedLevel[] = [];
  private sweepCandidates: SweepCandidate[] = [];

  constructor(equalityTolerance = 0, breakConfirmation: BreakConfirmationMode = "close") {
    this.equalityTolerance = sanitizeTolerance(equalityTolerance);
    this.breakConfirmation = breakConfirmation;
    this.resolver = new StructuralSwingResolver(this.equalityTolerance);
  }

  reset(): void {
    this.resolver.reset();
    this.trend = "unknown";
    this.transitionTarget = null;
    this.transitionStartedAtIndex = -1;
    this.transitionBrokenLevelPrice = 0;
    this.transitionCounterPrice = 0;
    this.activeProtectedLow = null;
    this.activeProtectedHigh = null;
    this.activeSwingHigh = null;
    this.activeSwingLow = null;
    this.candidatePullbackLow = null;
    this.candidatePullbackHigh = null;
    this.highestConfirmedHighInBullish = null;
    this.lowestConfirmedLowInBearish = null;
    this.breakEvents = [];
    this.protectedLevels = [];
    this.sweepCandidates = [];
  }

  /**
   * Advances the engine by one closed bar `barIndex` using only raw pivots whose
   * `confirmedAtIndex === barIndex`. Strictly causal: zero look-ahead.
   */
  stepBar(bar: StructureBar, barIndex: number, pivotsConfirmedAtBar: readonly SwingPivot[]): void {
    if (pivotsConfirmedAtBar.length > 0) {
      const update = this.resolver.pushConfirmedAt(pivotsConfirmedAtBar);
      this.onStructuralUpdate(update);
    }
    this.checkBarBreaks(bar, barIndex);
  }

  snapshot(): MarketStructureSnapshot {
    return {
      swings: this.resolver.getSwings(),
      ambiguousDualPivots: this.resolver.getAmbiguousDualPivots(),
      breakEvents: this.breakEvents,
      protectedLevels: this.protectedLevels,
      sweepCandidates: this.sweepCandidates,
      trend: this.trend,
      activeProtectedLow: this.activeProtectedLow,
      activeProtectedHigh: this.activeProtectedHigh,
      activeSwingHigh: this.activeSwingHigh,
      activeSwingLow: this.activeSwingLow,
    };
  }

  private activateProtectedLevel(kind: SwingKind, swing: StructuralSwing, atIndex: number): void {
    if (kind === "low") {
      if (this.activeProtectedLow && this.activeProtectedLow.status === "active") {
        this.activeProtectedLow.status = "superseded";
        this.activeProtectedLow.supersededAtIndex = atIndex;
      }
      const level: ProtectedLevel = {
        kind: "low",
        price: swing.price,
        pivotIndex: swing.pivotIndex,
        confirmedAtIndex: swing.confirmedAtIndex,
        activatedAtIndex: atIndex,
        brokenAtIndex: null,
        supersededAtIndex: null,
        status: "active",
      };
      this.protectedLevels.push(level);
      this.activeProtectedLow = level;
      this.activeProtectedHigh = null;
    } else {
      if (this.activeProtectedHigh && this.activeProtectedHigh.status === "active") {
        this.activeProtectedHigh.status = "superseded";
        this.activeProtectedHigh.supersededAtIndex = atIndex;
      }
      const level: ProtectedLevel = {
        kind: "high",
        price: swing.price,
        pivotIndex: swing.pivotIndex,
        confirmedAtIndex: swing.confirmedAtIndex,
        activatedAtIndex: atIndex,
        brokenAtIndex: null,
        supersededAtIndex: null,
        status: "active",
      };
      this.protectedLevels.push(level);
      this.activeProtectedHigh = level;
      this.activeProtectedLow = null;
    }
  }

  private enterBullish(high: StructuralSwing, low: StructuralSwing, atIndex: number): void {
    this.trend = "bullish";
    this.transitionTarget = null;
    this.transitionStartedAtIndex = -1;
    this.activateProtectedLevel("low", low, atIndex);
    this.activeSwingHigh = high;
    this.activeSwingLow = null;
    this.highestConfirmedHighInBullish = high;
    this.lowestConfirmedLowInBearish = null;
    this.candidatePullbackLow = null;
    this.candidatePullbackHigh = null;
  }

  private enterBearish(high: StructuralSwing, low: StructuralSwing, atIndex: number): void {
    this.trend = "bearish";
    this.transitionTarget = null;
    this.transitionStartedAtIndex = -1;
    this.activateProtectedLevel("high", high, atIndex);
    this.activeSwingLow = low;
    this.activeSwingHigh = null;
    this.lowestConfirmedLowInBearish = low;
    this.highestConfirmedHighInBullish = null;
    this.candidatePullbackHigh = null;
    this.candidatePullbackLow = null;
  }

  private onStructuralUpdate(update: StructuralSwingUpdate): void {
    const curr = update.activeSwing;
    if (!curr) return;
    const swings = this.resolver.getSwings();
    const prev = swings.length >= 2 ? swings[swings.length - 2] : undefined;

    if (this.trend === "unknown") {
      if (!prev) return;
      if ((prev.label === "HH" && curr.label === "HL") || (prev.label === "HL" && curr.label === "HH")) {
        const high = curr.kind === "high" ? curr : prev;
        const low = curr.kind === "low" ? curr : prev;
        this.enterBullish(high, low, curr.confirmedAtIndex);
      } else if ((prev.label === "LL" && curr.label === "LH") || (prev.label === "LH" && curr.label === "LL")) {
        const high = curr.kind === "high" ? curr : prev;
        const low = curr.kind === "low" ? curr : prev;
        this.enterBearish(high, low, curr.confirmedAtIndex);
      }
      return;
    }

    if (this.trend === "transition") {
      if (!prev || curr.confirmedAtIndex <= this.transitionStartedAtIndex) return;
      const high = curr.kind === "high" ? curr : prev;
      const low = curr.kind === "low" ? curr : prev;
      const isBullishPair = (high.label === "HH" || (this.transitionTarget === "bullish" && high.price > this.transitionBrokenLevelPrice + this.equalityTolerance))
        && (low.label === "HL" || (this.transitionTarget === "bullish" && low.price > this.transitionCounterPrice + this.equalityTolerance));
      const isBearishPair = (low.label === "LL" || (this.transitionTarget === "bearish" && low.price < this.transitionBrokenLevelPrice - this.equalityTolerance))
        && (high.label === "LH" || (this.transitionTarget === "bearish" && high.price < this.transitionCounterPrice - this.equalityTolerance));

      if (this.transitionTarget === "bearish") {
        if (isBearishPair) this.enterBearish(high, low, curr.confirmedAtIndex);
        else if (prev.label === "HH" && curr.label === "HL" || prev.label === "HL" && curr.label === "HH") {
          this.enterBullish(high, low, curr.confirmedAtIndex);
        }
      } else if (this.transitionTarget === "bullish") {
        if (isBullishPair) this.enterBullish(high, low, curr.confirmedAtIndex);
        else if (prev.label === "LL" && curr.label === "LH" || prev.label === "LH" && curr.label === "LL") {
          this.enterBearish(high, low, curr.confirmedAtIndex);
        }
      }
      return;
    }

    if (this.trend === "bullish") {
      if (curr.kind === "high") {
        if (!this.highestConfirmedHighInBullish || curr.price > this.highestConfirmedHighInBullish.price + this.equalityTolerance) {
          this.highestConfirmedHighInBullish = curr;
        }
        if (!this.activeSwingHigh || curr.price > this.activeSwingHigh.price + this.equalityTolerance) {
          this.activeSwingHigh = curr;
        }
      } else {
        if (
          update.replacedProvisional
          && update.supersededSwing
          && this.activeProtectedLow
          && update.supersededSwing.pivotIndex === this.activeProtectedLow.pivotIndex
        ) {
          if (curr.label === "HL" || curr.label === "EQL") {
            this.activateProtectedLevel("low", curr, curr.confirmedAtIndex);
          }
          return;
        }
        if (
          update.replacedProvisional
          && update.supersededSwing
          && this.candidatePullbackLow
          && update.supersededSwing.pivotIndex === this.candidatePullbackLow.pivotIndex
        ) {
          this.candidatePullbackLow = curr;
          return;
        }
        if (!this.candidatePullbackLow || curr.price < this.candidatePullbackLow.price - this.equalityTolerance) {
          this.candidatePullbackLow = curr;
        }
      }
      return;
    }

    if (this.trend === "bearish") {
      if (curr.kind === "low") {
        if (!this.lowestConfirmedLowInBearish || curr.price < this.lowestConfirmedLowInBearish.price - this.equalityTolerance) {
          this.lowestConfirmedLowInBearish = curr;
        }
        if (!this.activeSwingLow || curr.price < this.activeSwingLow.price - this.equalityTolerance) {
          this.activeSwingLow = curr;
        }
      } else {
        if (
          update.replacedProvisional
          && update.supersededSwing
          && this.activeProtectedHigh
          && update.supersededSwing.pivotIndex === this.activeProtectedHigh.pivotIndex
        ) {
          if (curr.label === "LH" || curr.label === "EQH") {
            this.activateProtectedLevel("high", curr, curr.confirmedAtIndex);
          }
          return;
        }
        if (
          update.replacedProvisional
          && update.supersededSwing
          && this.candidatePullbackHigh
          && update.supersededSwing.pivotIndex === this.candidatePullbackHigh.pivotIndex
        ) {
          this.candidatePullbackHigh = curr;
          return;
        }
        if (!this.candidatePullbackHigh || curr.price > this.candidatePullbackHigh.price + this.equalityTolerance) {
          this.candidatePullbackHigh = curr;
        }
      }
    }
  }

  private checkBarBreaks(bar: StructureBar, barIndex: number): void {
    const close = barClose(bar);
    if (this.trend === "bullish") {
      const protectedLow = this.activeProtectedLow;
      const swingHigh = this.activeSwingHigh;
      const chochResult = protectedLow && barIndex > protectedLow.confirmedAtIndex
        ? checkBreakBelow(bar, protectedLow.price, this.equalityTolerance, this.breakConfirmation)
        : null;
      const bosResult = swingHigh && barIndex > swingHigh.confirmedAtIndex
        ? checkBreakAbove(bar, swingHigh.price, this.equalityTolerance, this.breakConfirmation)
        : null;

      if (chochResult === "sweep" && protectedLow) {
        this.sweepCandidates.push({
          kind: "low",
          levelPrice: protectedLow.price,
          pivotIndex: protectedLow.pivotIndex,
          pivotConfirmedAtIndex: protectedLow.confirmedAtIndex,
          barIndex,
          wickPrice: bar.low,
          closePrice: close,
        });
      }
      if (bosResult === "sweep" && swingHigh) {
        this.sweepCandidates.push({
          kind: "high",
          levelPrice: swingHigh.price,
          pivotIndex: swingHigh.pivotIndex,
          pivotConfirmedAtIndex: swingHigh.confirmedAtIndex,
          barIndex,
          wickPrice: bar.high,
          closePrice: close,
        });
      }

      if (chochResult === "break" && protectedLow) {
        this.breakEvents.push({
          kind: "CHoCH",
          direction: "bearish",
          confirmation: this.breakConfirmation,
          levelPrice: protectedLow.price,
          pivotIndex: protectedLow.pivotIndex,
          pivotConfirmedAtIndex: protectedLow.confirmedAtIndex,
          breakIndex: barIndex,
          ...(bosResult === "break" ? { ambiguousSameBarBreak: true } : {}),
        });
        protectedLow.status = "broken";
        protectedLow.brokenAtIndex = barIndex;
        this.transitionBrokenLevelPrice = protectedLow.price;
        this.transitionCounterPrice = this.highestConfirmedHighInBullish?.price ?? Infinity;
        this.activeProtectedLow = null;
        this.activeSwingHigh = null;
        this.candidatePullbackLow = null;
        this.highestConfirmedHighInBullish = null;
        this.trend = "transition";
        this.transitionTarget = "bearish";
        this.transitionStartedAtIndex = barIndex;
        return;
      }

      if (bosResult === "break" && swingHigh) {
        this.breakEvents.push({
          kind: "BOS",
          direction: "bullish",
          confirmation: this.breakConfirmation,
          levelPrice: swingHigh.price,
          pivotIndex: swingHigh.pivotIndex,
          pivotConfirmedAtIndex: swingHigh.confirmedAtIndex,
          breakIndex: barIndex,
        });
        this.activeSwingHigh = null;
        if (this.candidatePullbackLow && this.candidatePullbackLow.pivotIndex !== this.activeProtectedLow?.pivotIndex) {
          this.activateProtectedLevel("low", this.candidatePullbackLow, barIndex);
        }
        this.candidatePullbackLow = null;
      }
      return;
    }

    if (this.trend === "bearish") {
      const protectedHigh = this.activeProtectedHigh;
      const swingLow = this.activeSwingLow;
      const chochResult = protectedHigh && barIndex > protectedHigh.confirmedAtIndex
        ? checkBreakAbove(bar, protectedHigh.price, this.equalityTolerance, this.breakConfirmation)
        : null;
      const bosResult = swingLow && barIndex > swingLow.confirmedAtIndex
        ? checkBreakBelow(bar, swingLow.price, this.equalityTolerance, this.breakConfirmation)
        : null;

      if (chochResult === "sweep" && protectedHigh) {
        this.sweepCandidates.push({
          kind: "high",
          levelPrice: protectedHigh.price,
          pivotIndex: protectedHigh.pivotIndex,
          pivotConfirmedAtIndex: protectedHigh.confirmedAtIndex,
          barIndex,
          wickPrice: bar.high,
          closePrice: close,
        });
      }
      if (bosResult === "sweep" && swingLow) {
        this.sweepCandidates.push({
          kind: "low",
          levelPrice: swingLow.price,
          pivotIndex: swingLow.pivotIndex,
          pivotConfirmedAtIndex: swingLow.confirmedAtIndex,
          barIndex,
          wickPrice: bar.low,
          closePrice: close,
        });
      }

      if (chochResult === "break" && protectedHigh) {
        this.breakEvents.push({
          kind: "CHoCH",
          direction: "bullish",
          confirmation: this.breakConfirmation,
          levelPrice: protectedHigh.price,
          pivotIndex: protectedHigh.pivotIndex,
          pivotConfirmedAtIndex: protectedHigh.confirmedAtIndex,
          breakIndex: barIndex,
          ...(bosResult === "break" ? { ambiguousSameBarBreak: true } : {}),
        });
        protectedHigh.status = "broken";
        protectedHigh.brokenAtIndex = barIndex;
        this.transitionBrokenLevelPrice = protectedHigh.price;
        this.transitionCounterPrice = this.lowestConfirmedLowInBearish?.price ?? -Infinity;
        this.activeProtectedHigh = null;
        this.activeSwingLow = null;
        this.candidatePullbackHigh = null;
        this.lowestConfirmedLowInBearish = null;
        this.trend = "transition";
        this.transitionTarget = "bullish";
        this.transitionStartedAtIndex = barIndex;
        return;
      }

      if (bosResult === "break" && swingLow) {
        this.breakEvents.push({
          kind: "BOS",
          direction: "bearish",
          confirmation: this.breakConfirmation,
          levelPrice: swingLow.price,
          pivotIndex: swingLow.pivotIndex,
          pivotConfirmedAtIndex: swingLow.confirmedAtIndex,
          breakIndex: barIndex,
        });
        this.activeSwingLow = null;
        if (this.candidatePullbackHigh && this.candidatePullbackHigh.pivotIndex !== this.activeProtectedHigh?.pivotIndex) {
          this.activateProtectedLevel("high", this.candidatePullbackHigh, barIndex);
        }
        this.candidatePullbackHigh = null;
      }
    }
  }
}
