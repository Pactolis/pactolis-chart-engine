// Pure trade/bar validation helpers. Lives in core so core modules (e.g.
// core/model/footprint.ts) can use them without a runtime import from
// features (layer rule: core must not import features at runtime).
// This module is the canonical runtime owner for feature data-contract helpers.
import type { AggTrade, FootprintBar } from "./types.js";
import { WEEK_MS, bucketStart, monthSpan } from "./time.js";

export class DataContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DataContractError";
  }
}

export function validateTrade(trade: AggTrade): AggTrade {
  if (!Number.isFinite(trade.time) || trade.time < 0) {
    throw new DataContractError("INVALID_TRADE_TIME", "Trade time must be a positive epoch value");
  }
  if (!Number.isFinite(trade.price) || trade.price <= 0) {
    throw new DataContractError("INVALID_TRADE_PRICE", "Trade price must be positive");
  }
  if (!Number.isFinite(trade.qty) || trade.qty <= 0) {
    throw new DataContractError("INVALID_TRADE_QUANTITY", "Trade quantity must be positive");
  }
  if (trade.tradeCount !== undefined && (!Number.isSafeInteger(trade.tradeCount) || trade.tradeCount <= 0)) {
    throw new DataContractError("INVALID_TRADE_COUNT", "Trade count must be a positive safe integer");
  }
  return trade;
}

export function validateBar(bar: FootprintBar, intervalMs: number): FootprintBar {
  const expectedStart = bucketStart(bar.startTime, intervalMs);
  // Month-token history can contain both the current calendar-aligned contract
  // and legacy cache rows aligned to fixed 30-day multiples. Accept the legacy
  // form only for month tokens; all intraday/daily/weekly bars stay strict.
  const legacyMonthStart = monthSpan(intervalMs) > 0
    && Math.floor(bar.startTime / intervalMs) * intervalMs === bar.startTime;
  const legacyWeekStart = (intervalMs === WEEK_MS || intervalMs === 2 * WEEK_MS)
    && Math.floor(bar.startTime / intervalMs) * intervalMs === bar.startTime;
  if (!Number.isFinite(bar.startTime) || bar.startTime < 0 ||
      (expectedStart !== bar.startTime && !legacyMonthStart && !legacyWeekStart)) {
    throw new DataContractError(
      "INVALID_BAR_TIME",
      `Bar start must align to its interval (start=${bar.startTime}, interval=${intervalMs}, expected=${expectedStart})`,
    );
  }
  for (const [name, value] of Object.entries({
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume, delta: bar.delta, count: bar.count,
  })) {
    if (!Number.isFinite(value)) throw new DataContractError("INVALID_BAR_NUMBER", `${name} is not finite`);
  }
  if (bar.high < bar.low || bar.open < bar.low || bar.open > bar.high ||
      bar.close < bar.low || bar.close > bar.high || bar.volume < 0 || bar.count < 0) {
    throw new DataContractError("INVALID_BAR_RANGE", "Bar OHLC/volume invariants failed");
  }
  if (bar.deltaBySize !== undefined && (!Array.isArray(bar.deltaBySize) || bar.deltaBySize.some((value) => !Number.isFinite(value)))) {
    throw new DataContractError("INVALID_BAR_DELTA_BY_SIZE", "deltaBySize must be a finite number array when present");
  }
  return bar;
}

export function tradeFingerprint(trade: AggTrade): string {
  return trade.id
    ? `${trade.market ?? ""}|${trade.id}`
    : `${trade.market ?? ""}|${trade.time}|${trade.price}|${trade.qty}|${trade.tradeCount ?? 1}|${trade.isBuy ? 1 : 0}|${trade.liquidation ? 1 : 0}`;
}
