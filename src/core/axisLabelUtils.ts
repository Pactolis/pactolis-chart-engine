import type { View } from "./engine/view.js";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function clampLabelY(view: View, y: number, boxH: number, pad = 2): number {
  const top = view.area.top + boxH / 2 + pad;
  const bottom = view.area.top + view.area.height - boxH / 2 - pad;
  return clamp(y, Math.min(top, bottom), Math.max(top, bottom));
}

export interface VerticalLabelCandidate {
  desiredY: number;
  priority: number;
  boxH: number;
}

type OrderedCandidate<T extends VerticalLabelCandidate> = T & { order: number };

export function placeVerticalLabels<T extends VerticalLabelCandidate>(
  items: T[],
  top: number,
  bottom: number,
  gap = 2
): (T & { y: number })[] {
  if (bottom <= top) return [];
  const candidates = items
    .map((item, order) => ({ ...item, order }))
    .filter((item) => Number.isFinite(item.desiredY) && Number.isFinite(item.boxH) && item.boxH > 0)
    .sort((a, b) => b.priority - a.priority || a.order - b.order);
  const selected: OrderedCandidate<T>[] = [];

  for (const candidate of candidates) {
    const attempt = layoutOrderedLabels([...selected, candidate], top, bottom, gap);
    if (attempt) selected.push(candidate);
  }

  const labels = layoutOrderedLabels(selected, top, bottom, gap) ?? [];
  return labels
    .map((label) => {
      const { order: _order, ...withoutOrder } = label;
      return withoutOrder as T & { y: number };
    })
    .sort((a, b) => a.y - b.y || b.priority - a.priority);
}

function layoutOrderedLabels<T extends VerticalLabelCandidate>(
  items: OrderedCandidate<T>[],
  top: number,
  bottom: number,
  gap: number
): (OrderedCandidate<T> & { y: number })[] | null {
  if (!items.length) return [];
  const ordered = [...items].sort((a, b) =>
    a.desiredY - b.desiredY || b.priority - a.priority || a.order - b.order
  );
  const minCenters = ordered.map((item) => top + item.boxH / 2 + gap);
  const maxCenters = ordered.map((item) => bottom - item.boxH / 2 - gap);
  if (minCenters.some((minCenter, index) => maxCenters[index] < minCenter)) return null;

  const y = ordered.map((item, index) => clamp(item.desiredY, minCenters[index], maxCenters[index]));
  applyForwardSpacing(ordered, y, minCenters, gap);
  applyBackwardSpacing(ordered, y, maxCenters, gap);
  applyForwardSpacing(ordered, y, minCenters, gap);

  const epsilon = 1e-6;
  for (let index = 0; index < ordered.length; index += 1) {
    if (y[index] < minCenters[index] - epsilon || y[index] > maxCenters[index] + epsilon) return null;
    if (index > 0 && y[index] < y[index - 1] + minCenterDistance(ordered[index - 1], ordered[index], gap) - epsilon) {
      return null;
    }
  }

  return ordered.map((item, index) => ({ ...item, y: y[index] }));
}

function applyForwardSpacing<T extends VerticalLabelCandidate>(
  ordered: OrderedCandidate<T>[],
  y: number[],
  minCenters: number[],
  gap: number
): void {
  for (let index = 0; index < ordered.length; index += 1) {
    const minFromPrevious = index === 0
      ? minCenters[index]
      : y[index - 1] + minCenterDistance(ordered[index - 1], ordered[index], gap);
    y[index] = Math.max(y[index], minCenters[index], minFromPrevious);
  }
}

function applyBackwardSpacing<T extends VerticalLabelCandidate>(
  ordered: OrderedCandidate<T>[],
  y: number[],
  maxCenters: number[],
  gap: number
): void {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const maxFromNext = index === ordered.length - 1
      ? maxCenters[index]
      : y[index + 1] - minCenterDistance(ordered[index], ordered[index + 1], gap);
    y[index] = Math.min(y[index], maxCenters[index], maxFromNext);
  }
}

function minCenterDistance(a: VerticalLabelCandidate, b: VerticalLabelCandidate, gap: number): number {
  return a.boxH / 2 + b.boxH / 2 + gap;
}

/**
 * Decimal places to display for a given price step.
 * Uses log10 magnitude instead of string parsing to avoid scientific-notation
 * artifacts (e.g. "4.9999999999999903e-6" would give 19 from naive string parse).
 */
export function priceDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(10, Math.max(0, -Math.floor(Math.log10(step))));
}

/** Decimal places from config: uses pricePrecision when available, else derives from priceStep. */
export function configDecimals(config: { priceStep: number; pricePrecision?: number }): number {
  return config.pricePrecision ?? priceDecimals(config.priceStep);
}
