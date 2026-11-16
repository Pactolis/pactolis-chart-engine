/** Asynchronous market metadata, price-step, and price-precision resolution coordinator. */
import type { FootprintSeries } from "../../../core/model/footprint.js";
import type { EnvelopeMeta } from "../../../core/envelope.js";
import type { ChartDataPipelineServices } from "../ChartDataPipelinePorts.js";
import { abortableDelay } from "../abortableDelay.js";

export const PRICE_STEP_RESOLVE_TIMEOUT_MS = 6000;
/**
 * Background retries for a market selection's step lookup that came back unresolved (for
 * example while the Gateway was briefly not online). The mount path retries on its own; a
 * selection has only this chain, so without it the fallback grid would stay for good.
 */
export const SELECTION_PRICE_STEP_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

async function raceWithFallback<T>(promise: Promise<T>, fallback: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface PriceStepResolutionHost {
  readonly series: FootprintSeries;
  readonly services: Pick<ChartDataPipelineServices, "fetchPriceStep" | "fetchPriceStepResult" | "fetchPricePrecision">;
  readonly stepResolveTimeoutMs: number;
  readonly stepRetryDelaysMs: readonly number[];
  readonly disposalSignal: AbortSignal;
  readonly onServerPriceStep?: (step: number) => void | Promise<void>;
  isDisposed(): boolean;
  getMarket(): string;
  setPriceStep(step: number): void;
  emitMetadataUpdated(): void;
}

export class PriceStepResolutionCoordinator {
  pendingStepCorrection: Promise<number | null> = Promise.resolve(null);
  /** Price step/precision lookup of the latest market switch; a timeframe change made meanwhile waits for it. */
  pendingMarketMetadata: Promise<void> | null = null;

  constructor(private readonly host: PriceStepResolutionHost) {}

  reportServerPriceStep(meta: EnvelopeMeta | undefined): void {
    // Fire-and-forget consumer of the notifier: keep the optional adoption return
    // handled so history metadata can never leak an unhandled rejection.
    void Promise.resolve(this.reportServerStepValue(meta?.footprint?.priceStep))
      .catch(() => { /* history failures surface through the load error state */ });
  }

  /**
   * Guarded pure notifier for a server-served price step: a history envelope's
   * footprint grid or a resolved selection-metadata correction. It only reports;
   * adoption belongs to the consumer's managed setter. The call stays synchronous;
   * it may return the consumer's owned adoption promise for awaiting callers,
   * while fire-and-forget callers keep their own error handling.
   */
  reportServerStepValue(serverStep: number | undefined): Promise<void> | void {
    if (!this.host.onServerPriceStep || serverStep === undefined || !Number.isFinite(serverStep) || !(serverStep > 0)) return;
    if (Math.abs(serverStep - this.host.series.config.priceStep) <= serverStep * 1e-9) return;
    // Pure optional notifier: the pipeline only reports the served grid. Adopting it
    // here (series.setPriceStep) would clear every bar, dedup floor and repair fence
    // and bump the reset epoch while bypassing the managed setPriceStep contract
    // (generation/cancel/queue reset). Adoption belongs to the consumer: the runtime
    // callback re-enters through its managed setter (reset + reload); callers
    // re-verify load ownership after it before touching load state.
    return this.host.onServerPriceStep(serverStep);
  }

  async resolveMarketMetadata(market: string): Promise<void> {
    const fallbackStep = this.host.series.config.priceStep;
    this.host.series.resetPricePrecision();
    this.host.series.setReferenceMarket(market);
    const stepResultPromise = this.host.services.fetchPriceStepResult
      ? this.host.services.fetchPriceStepResult(market)
      : this.host.services.fetchPriceStep(market).then((step) => ({ step, resolved: true }));
    const pricePrecisionPromise = this.host.services.fetchPricePrecision(market);
    const [stepResult, pricePrecision] = await Promise.all([
      raceWithFallback(stepResultPromise, { step: fallbackStep, resolved: false }, this.host.stepResolveTimeoutMs),
      raceWithFallback(pricePrecisionPromise, undefined, 1500),
    ]);
    if (this.host.isDisposed() || this.host.getMarket() !== market) return;
    const priceStep = stepResult.step;
    this.host.series.setPriceStep(priceStep);
    if (pricePrecision !== undefined) {
      this.host.series.setPricePrecision(pricePrecision);
      this.host.emitMetadataUpdated();
    }
    this.pendingStepCorrection = stepResult.resolved
      ? Promise.resolve(null)
      : stepResultPromise.then(async (first) => {
          // An unresolved lookup (e.g. made while the Gateway was briefly not online) is
          // asked again in the background; nothing else retries a selection's step.
          let real = first;
          for (const delay of this.host.stepRetryDelaysMs) {
            if (real.resolved || !this.host.services.fetchPriceStepResult) break;
            if (!(await abortableDelay(delay, this.host.disposalSignal))) return null;
            if (this.host.isDisposed() || this.host.getMarket() !== market) return null;
            real = await this.host.services.fetchPriceStepResult(market).catch(() => real);
          }
          if (this.host.isDisposed() || this.host.getMarket() !== market) return null;
          if (!real.resolved || !Number.isFinite(real.step) || real.step <= 0) return null;
          // Compare against the step the series runs now, not the fallback captured above:
          // a managed adoption since then already owns an equal served grid.
          if (Math.abs(real.step - this.host.series.config.priceStep) <= real.step * 1e-9) return null;
          // A different step must not raw-clear the series here (that drops every bar,
          // dedup floor and repair fence outside the managed contract); report it so the
          // host adopts it through its managed setPriceStep (reset + covered reload).
          // Without a runtime subscriber nobody re-enters that contract, so a standalone
          // pipeline adopts the resolved selection step itself through the same managed
          // setter; reportServerStepValue stays a pure notifier for the hosted path.
          // Awaiting the returned owned adoption keeps this correction pending until
          // the covered replacement load commits, so consumers restore against the
          // real replacement bars instead of an empty mid-reset grid.
          if (this.host.onServerPriceStep) await this.reportServerStepValue(real.step);
          else this.host.setPriceStep(real.step);
          return real.step;
        }).catch(() => null);
  }

  async trackMarketSwitch(market: string): Promise<void> {
    const metadata = this.resolveMarketMetadata(market);
    this.pendingMarketMetadata = metadata;
    const settle = () => {
      if (this.pendingMarketMetadata === metadata) this.pendingMarketMetadata = null;
    };
    metadata.then(settle, settle);
    await metadata;
  }

  async awaitPendingMarketMetadata(): Promise<void> {
    if (!this.pendingMarketMetadata) return;
    await this.pendingMarketMetadata.catch(() => undefined);
  }
}
