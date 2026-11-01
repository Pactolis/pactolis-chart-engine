import { hasChartAutomaticVisibility, type ChartPanelState } from "../../core/chartPanelState.js";
import type { AnalysisContext, AutomaticLevelsAsOf } from "../../core/analysisContext.js";
import type { NakedPocLevel } from "../../core/analysis/nakedPoc.js";
import { PERIOD_INTERVAL } from "../../core/analysis/periods.js";
import { bucketEnd } from "../../core/time.js";
import type { ChartRuntimeServices } from "./ChartServicePorts.js";
import type { ChartDataPipeline } from "./ChartDataPipeline.js";
import type { View } from "../../core/engine/view.js";
import type { ChartSession } from "./ChartSession.js";
import type { ChartReplayCoordinator } from "./ChartReplayCoordinator.js";

export interface ChartLevelContextHost {
  readonly state: ChartPanelState;
  readonly pipeline: ChartDataPipeline;
  readonly view: View;
  readonly svc: ChartRuntimeServices;
  readonly session: ChartSession;
  readonly replayCoordinator: ChartReplayCoordinator;
  isDisposed(): boolean;
  updateHook(): void;
}

/**
 * Owns nPOC snapshot fetching/settling lifecycle, replay-time automatic levels caching,
 * and per-chart analysis visibility filtering.
 */
export class ChartLevelContextController {
  private npocGeneration = 0;
  private npocController: AbortController | null = null;
  npocMarket: string | null = null;
  private npocPending: NakedPocLevel[] | null = null;
  npocLevels: NakedPocLevel[] = [];
  private npocHistoryReady = false;
  private readonly npocListeners = new Set<() => void>();

  private replayLevelsCache: {
    key: {
      market: string;
      revision: number;
      asOf: number;
      previousWeek: AnalysisContext["previousWeekStrategySettings"];
      monday: AnalysisContext["mondayRangeSettings"];
    };
    levels: AutomaticLevelsAsOf;
  } | null = null;

  private cachedAnalysisServiceRaw: AnalysisContext | null = null;
  private cachedAnalysisRevision = 0;
  private cachedAnalysisPwSettings: unknown = null;
  private cachedAnalysisMrSettings: unknown = null;
  private cachedAnalysisStateRef: ChartPanelState | null = null;
  private cachedAnalysisNpocLevels: readonly NakedPocLevel[] | null = null;
  private cachedAnalysisNpocMarket: string | null = null;
  private cachedAnalysisReplayTime: number | undefined = undefined;
  private cachedAnalysisContext: AnalysisContext | null = null;

  constructor(private readonly host: ChartLevelContextHost) {}

  beginNpocRequest(market: string): void {
    const generation = ++this.npocGeneration;
    this.npocController?.abort();
    const controller = new AbortController();
    this.npocController = controller;
    this.npocMarket = market;
    this.npocPending = null;
    this.npocLevels = [];
    this.npocHistoryReady = false;
    this.notifyNpocListeners();
    this.host.session?.invalidate();

    void this.host.svc.fetchNpocSnapshot(market, controller.signal).then((response) => {
      if (
        this.host.isDisposed()
        || controller.signal.aborted
        || generation !== this.npocGeneration
        || market !== this.host.state.market
      ) return;
      this.npocPending = response.levels.map((level) => ({
        id: `${market}|${level.period}|${level.periodStart}`,
        market,
        period: level.period,
        periodStart: level.periodStart,
        periodEnd: bucketEnd(level.periodStart, PERIOD_INTERVAL[level.period]),
        price: level.pocLower,
        age: level.age,
        complete: true as const,
      }));
      this.host.updateHook();
      this.maybeApplyNpoc();
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== this.npocGeneration) return;
      console.warn("[chart.npoc] snapshot unavailable", error);
    });
  }

  notifyNpocHistorySettled(market: string, timeframe: string): void {
    if (market !== this.host.state.market || timeframe !== this.host.state.timeframe) return;
    this.npocHistoryReady = true;
    this.maybeApplyNpoc();
    this.host.updateHook();
  }

  maybeApplyNpoc(): void {
    if (
      this.host.isDisposed()
      || !this.npocHistoryReady
      || this.npocPending === null
      || this.npocMarket !== this.host.state.market
      || this.host.pipeline.series.length === 0
      || this.host.view.area.width <= 1
      || this.host.view.area.height <= 1
      || this.host.view.priceRange() === null
    ) return;
    this.npocLevels = this.npocPending;
    this.npocPending = null;
    this.notifyNpocListeners();
    this.host.session?.invalidate();
  }

  getNpocLevels(): readonly NakedPocLevel[] {
    if (this.host.replayCoordinator.isActive()) return [];
    return this.npocMarket === this.host.state.market ? this.npocLevels : [];
  }

  getNpocLevelsRaw(): readonly NakedPocLevel[] {
    return this.npocLevels;
  }

  getPendingNpocCount(): number {
    return this.npocPending?.length ?? 0;
  }

  isNpocHistoryReady(): boolean {
    return this.npocHistoryReady;
  }

  subscribeNpoc(listener: () => void): () => void {
    this.npocListeners.add(listener);
    return () => this.npocListeners.delete(listener);
  }

  private notifyNpocListeners(): void {
    for (const listener of this.npocListeners) listener();
  }

  automaticLevelsAsOf(market: string, asOf: number, context: AnalysisContext): AutomaticLevelsAsOf {
    const revision = this.host.svc.getAnalysisRevisionSnapshot(market).revision;
    const key = {
      market,
      revision,
      asOf,
      previousWeek: context.previousWeekStrategySettings,
      monday: context.mondayRangeSettings,
    };
    const cached = this.replayLevelsCache;
    if (cached && (Object.keys(key) as (keyof typeof key)[]).every((name) => cached.key[name] === key[name])) {
      return cached.levels;
    }
    const levels = this.host.svc.getAutomaticLevelsAsOf?.(market, asOf)
      ?? { previousWeekStrategyLevels: [], mondayRangeLevels: [], referenceLevels: [] };
    this.replayLevelsCache = { key, levels };
    return levels;
  }

  replayAutomaticLevels(context: AnalysisContext): AutomaticLevelsAsOf | null {
    const replayTime = this.host.replayCoordinator.isActive() ? this.host.replayCoordinator.getSnapshot()?.virtualTime : undefined;
    return replayTime === undefined ? null : this.automaticLevelsAsOf(this.host.state.market, replayTime, context);
  }

  getReplayAutomaticLevels(): AutomaticLevelsAsOf | null {
    return this.replayAutomaticLevels(this.host.svc.getAnalysisContext(this.host.state.market, true));
  }

  analysisContextForChart(): AnalysisContext {
    const serviceRaw = this.host.svc.getAnalysisContext(this.host.state.market, true);
    const revision = this.host.svc.getAnalysisRevisionSnapshot(this.host.state.market).revision;
    const pwSettings = serviceRaw.previousWeekStrategySettings;
    const mrSettings = serviceRaw.mondayRangeSettings;
    const replayTime = this.host.replayCoordinator.isActive() ? this.host.replayCoordinator.getSnapshot()?.virtualTime : undefined;

    if (
      this.cachedAnalysisContext !== null
      && this.cachedAnalysisServiceRaw === serviceRaw
      && this.cachedAnalysisRevision === revision
      && this.cachedAnalysisPwSettings === pwSettings
      && this.cachedAnalysisMrSettings === mrSettings
      && this.cachedAnalysisStateRef === this.host.state
      && this.cachedAnalysisNpocLevels === this.npocLevels
      && this.cachedAnalysisNpocMarket === this.npocMarket
      && this.cachedAnalysisReplayTime === replayTime
    ) {
      return this.cachedAnalysisContext;
    }

    const replayLevels = this.replayAutomaticLevels(serviceRaw);
    const raw: AnalysisContext = replayLevels === null
      ? { ...serviceRaw, nakedPocs: this.npocMarket === this.host.state.market ? this.npocLevels : [] }
      : { ...serviceRaw, ...replayLevels, nakedPocs: [] };

    let result: AnalysisContext;
    if (!hasChartAutomaticVisibility(this.host.state)) {
      result = raw;
    } else {
      const previousWeekStrategySettings = {
        ...raw.previousWeekStrategySettings,
        visible: {
          ...raw.previousWeekStrategySettings.visible,
          ...(this.host.state.previousWeekStrategyVisibility ?? {}),
        },
      };
      const mondayRangeSettings = {
        ...raw.mondayRangeSettings,
        visible: {
          ...raw.mondayRangeSettings.visible,
          ...(this.host.state.mondayRangeVisibility ?? {}),
        },
      };
      const hiddenNakedPocIds = new Set(this.host.state.hiddenNakedPocIds ?? []);
      const hiddenReferenceLevelIds = new Set(this.host.state.hiddenReferenceLevelIds ?? []);

      result = {
        ...raw,
        previousWeekStrategySettings,
        previousWeekStrategyLevels: raw.previousWeekStrategyLevels.filter(
          (level) => previousWeekStrategySettings.visible[level.id] !== false,
        ),
        mondayRangeSettings,
        mondayRangeLevels: raw.mondayRangeLevels.filter(
          (level) => mondayRangeSettings.visible[level.id] !== false,
        ),
        nakedPocs: raw.nakedPocs.filter(
          (level) => (this.host.state.nakedPocVisibility?.[level.period] ?? false) !== false
            && !hiddenNakedPocIds.has(level.id),
        ),
        referenceLevels: raw.referenceLevels.filter(
          (level) => (this.host.state.referenceVisibility?.[level.family]?.[level.period] ?? true) !== false
            && !hiddenReferenceLevelIds.has(level.id),
        ),
      };
    }

    this.cachedAnalysisServiceRaw = serviceRaw;
    this.cachedAnalysisRevision = revision;
    this.cachedAnalysisPwSettings = pwSettings;
    this.cachedAnalysisMrSettings = mrSettings;
    this.cachedAnalysisStateRef = this.host.state;
    this.cachedAnalysisNpocLevels = this.npocLevels;
    this.cachedAnalysisNpocMarket = this.npocMarket;
    this.cachedAnalysisReplayTime = replayTime;
    this.cachedAnalysisContext = result;
    return result;
  }

  dispose(): void {
    this.npocController?.abort();
    this.npocController = null;
    this.npocGeneration++;
    this.npocListeners.clear();
  }
}
