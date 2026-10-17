/**
 * Price-axis marks.
 *
 * Renderers do not choose price tick spacing themselves. They ask the price
 * scale model for marks and draw them, so linear and logarithmic axes share
 * one placement policy.
 */

import type { PriceScaleModel } from "./priceScale.js";
import { priceTickStep, smallestLabelStep } from "./priceTickStep.js";

export interface PriceMark {
  /** Coordinate relative to the top of the price scale pane. */
  coord: number;
  /** Label text already formatted for the active scale mode. */
  label: string;
  /** Logical value in active scale-space. */
  logical: number;
  /** Raw price value represented by the mark. */
  price: number;
}

export interface PriceTickMarkBuildParams {
  priceScale: PriceScaleModel;
  /** Price scale pane height in px. */
  height: number;
  /** Scale-space value at the top edge. */
  priceTop: number;
  /** Scale-space units per px. */
  pricePerPx: number;
  /** Decimal places used for labels. */
  pricePrecision: number;
  /** Optional font size override. */
  fontSize?: number;
  /** Optional density override; defaults to priceScale.tickMarkDensity(). */
  tickMarkDensity?: number;
  /** When enabled, marks too close to top/bottom are skipped. */
  entireTextOnly?: boolean;
}

/**
 * Marks run from the top of the axis downwards on multiples of the tick step.
 * Marks closer than one label height to the previous mark, or outside the
 * drawable band, are left out. On a logarithmic axis the step is re-chosen
 * below every mark, because equal price steps shrink on screen as price rises.
 */
export function buildPriceMarks(params: PriceTickMarkBuildParams): PriceMark[] {
  const { priceScale, priceTop, pricePerPx } = params;
  const height = Math.max(0, params.height);
  if (height <= 1 || !Number.isFinite(priceTop) || !Number.isFinite(pricePerPx) || pricePerPx <= 0) return [];

  const priceAt = (coord: number): number => priceScale.logicalToPrice(priceTop - coord * pricePerPx);
  const coordOf = (price: number): number | null => {
    const logical = priceScale.priceToLogical(price);
    return logical === null || !Number.isFinite(logical) ? null : (priceTop - logical) / pricePerPx;
  };

  // Steps are chosen in price space; in log mode the converters map the edge
  // coordinates back to raw prices and every mark back to a coordinate.
  const edgeA = priceAt(0);
  const edgeB = priceAt(height - 1);
  const high = Math.max(edgeA, edgeB);
  const low = Math.min(edgeA, edgeB);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high === low) return [];

  const fontSize = params.fontSize ?? 11;
  const density = params.tickMarkDensity ?? priceScale.tickMarkDensity();
  const labelHeight = Math.ceil(fontSize * density);
  const minSpacing = (high - low) * labelHeight / height;
  const minStep = smallestLabelStep(params.pricePrecision);
  const stepBelow = (price: number) => priceTickStep(Math.max(price, low), low, minSpacing, minStep);
  const usable = (step: number) => Number.isFinite(step) && step > 0;

  let step = stepBelow(high);
  if (!usable(step)) return [];

  const inset = params.entireTextOnly === true ? fontSize / 2 : 0;
  const topLimit = inset;
  const bottomLimit = height - 1 - inset;
  const logarithmic = priceScale.isLogarithmic();
  const marks: PriceMark[] = [];
  let lastCoord: number | null = null;

  for (let price = high - positiveRemainder(high, step); price > low; price -= step) {
    const coord = coordOf(price);
    const placeable = coord !== null
      && Number.isFinite(coord)
      && (lastCoord === null || Math.abs(coord - lastCoord) >= labelHeight)
      && coord >= topLimit
      && coord <= bottomLimit;
    if (placeable) {
      const logical = priceScale.priceToLogical(price);
      if (logical !== null && Number.isFinite(logical)) {
        marks.push({ coord, label: formatPriceMark(price, params.pricePrecision), logical, price });
        lastCoord = coord;
      }
    }
    if (logarithmic) {
      step = stepBelow(price);
      if (!usable(step)) break;
    }
  }
  return marks;
}

function positiveRemainder(value: number, divisor: number): number {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

export function formatPriceMark(price: number, pricePrecision: number): string {
  if (!Number.isFinite(price)) return "";
  const precision = Math.max(0, Math.min(12, Math.floor(pricePrecision)));
  return price.toFixed(precision);
}
