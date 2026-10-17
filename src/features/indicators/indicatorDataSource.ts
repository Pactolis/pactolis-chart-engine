import type { CoinalyzeDerivativeRequestInput, CoinalyzeDerivativeSeriesState } from "./metricContracts.js";
import type { FuturesPositioningRequestInput, FuturesPositioningSeriesState } from "./metricContracts.js";
import type { LiquidationRequestInput, LiquidationSeriesState } from "./metricContracts.js";
import type { GexWallSurface } from "./gexWall.js";

export interface OptionsGexSurfaceRequest {
  base: "BTC" | "ETH" | "SOL" | "HYPE" | "XRP";
  maxExpiryDays: number;
}

/**
 * Market data behind the indicators that do not draw from the chart's own
 * bars. The engine does not fetch it; the host application supplies the
 * source before mounting a chart. The series requests return the cached state
 * at once and call `onUpdate` when it changes.
 */
export interface IndicatorDataSource {
  requestLiquidationSeries(input: LiquidationRequestInput): LiquidationSeriesState;
  requestCoinalyzeDerivativeSeries(input: CoinalyzeDerivativeRequestInput): CoinalyzeDerivativeSeriesState;
  requestFuturesPositioningSeries(input: FuturesPositioningRequestInput): FuturesPositioningSeriesState;
  fetchOptionsGexSurface(request: OptionsGexSurfaceRequest, signal?: AbortSignal): Promise<GexWallSurface>;
}

let configured: IndicatorDataSource | null = null;

export function configureIndicatorDataSource(source: IndicatorDataSource): void {
  configured = source;
}

export function indicatorDataSource(): IndicatorDataSource {
  if (configured === null) {
    throw new Error("indicator data source is not configured; call configureIndicatorDataSource() before mounting a chart");
  }
  return configured;
}
