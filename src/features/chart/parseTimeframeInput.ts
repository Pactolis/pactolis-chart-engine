import { TIMEFRAMES } from "../../core/timeframes.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

/**
 * Convert keyboard timeframe input into a supported TIMEFRAMES label.
 * Bare numbers are minutes. Suffixes follow the chart's timeframe labels:
 * m = minutes, M = months (case matters); h, d and w are case-insensitive.
 */
export function parseTimeframeInput(raw: string): string | null {
  const match = /^(\d+)([hHdDwWmM]?)$/.exec(raw.trim());
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;

  let ms: number;
  const unit = match[2] === "M" ? "M" : match[2].toLowerCase();
  switch (unit) {
    case "":
    case "m":
      ms = value * MIN;
      break;
    case "h":
      ms = value * HOUR;
      break;
    case "d":
      ms = value * DAY;
      break;
    case "w":
      ms = value * WEEK;
      break;
    case "M":
      ms = value * MONTH;
      break;
    default:
      return null;
  }
  return TIMEFRAMES.find((timeframe) => timeframe.ms === ms)?.label ?? null;
}

export interface TimeframeKeyboardEventLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface TimeframeInputState {
  buffer: string;
  invalid: boolean;
}

export interface TimeframeInputSubmission {
  raw: string;
  label: string | null;
}

export interface TimeframeInputTransition {
  handled: boolean;
  state: TimeframeInputState;
  submission?: TimeframeInputSubmission;
}

const EMPTY_INPUT: TimeframeInputState = { buffer: "", invalid: false };

function isPrintableKey(key: string): boolean {
  return key.length === 1;
}

export function isTimeframeInputSyntax(raw: string): boolean {
  return /^(\d+)([hHdDwWmM]?)$/.test(raw);
}

function hasUnitSuffix(raw: string): boolean {
  return /^(\d+)[hHdDwWmM]$/.test(raw);
}

export function nextTimeframeInputState(
  state: TimeframeInputState,
  event: TimeframeKeyboardEventLike,
): TimeframeInputTransition {
  if (event.ctrlKey || event.altKey || event.metaKey) return { handled: false, state };

  if (event.key === "Escape") {
    if (!state.buffer) return { handled: false, state };
    return { handled: true, state: { ...EMPTY_INPUT } };
  }

  if (event.key === "Backspace") {
    if (!state.buffer) return { handled: false, state };
    const buffer = state.buffer.slice(0, -1);
    return {
      handled: true,
      state: buffer ? { buffer, invalid: !isTimeframeInputSyntax(buffer) } : { ...EMPTY_INPUT },
    };
  }

  if (event.key === "Enter") {
    if (!state.buffer) return { handled: false, state };
    const raw = state.buffer;
    const label = state.invalid ? null : parseTimeframeInput(raw);
    return { handled: true, state: { ...EMPTY_INPUT }, submission: { raw, label } };
  }

  if (/^[0-9hHdDwWmM]$/.test(event.key)) {
    if (!state.buffer && !/^[0-9]$/.test(event.key)) return { handled: false, state };
    if (state.invalid || hasUnitSuffix(state.buffer)) {
      return { handled: true, state: { buffer: state.buffer, invalid: true } };
    }
    const buffer = state.buffer + event.key;
    return {
      handled: true,
      state: { buffer, invalid: !isTimeframeInputSyntax(buffer) },
    };
  }

  if (state.buffer && isPrintableKey(event.key)) {
    return {
      handled: true,
      state: { buffer: state.buffer, invalid: true },
    };
  }

  return { handled: false, state };
}
