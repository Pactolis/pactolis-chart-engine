import { readFileSync } from "node:fs";
import { calculateOrderFlowProfile } from "../dist/core/analysis/orderFlowProfile.js";

const fixture = JSON.parse(readFileSync(
  new URL("../tests/fixtures/binance-btcusdt-2026-11-10-1m.json", import.meta.url),
  "utf8",
));
const baseIntervalMs = 60_000;
const priceStep = 1;
const durations = [
  { label: "1h", barsByResolution: { "1m": 60, "5m": 12, "1h": 1 } },
  { label: "6h", barsByResolution: { "1m": 360, "5m": 72, "1h": 6 } },
  { label: "24h", barsByResolution: { "1m": 1_440, "5m": 288, "1h": 24 } },
];

function splitFloat(total, weights) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  let assigned = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return total - assigned;
    const part = total * weight / sum;
    assigned += part;
    return part;
  });
}

function splitCount(total, weights) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const parts = weights.map((weight) => Math.floor(total * weight / sum));
  let remaining = total - parts.reduce((value, part) => value + part, 0);
  const remainders = weights
    .map((weight, index) => ({ index, remainder: total * weight / sum - parts[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) parts[remainders[index].index] += 1;
  return parts;
}

function syntheticPriceRange(index) {
  const center = 50_000 + Math.round(42 * Math.sin(index / 37) + 15 * Math.sin(index / 9));
  const open = center + ((index % 5) - 2);
  const close = center + (((index * 7) % 7) - 3);
  const wick = 2 + (index % 4);
  return {
    open,
    close,
    low: Math.min(open, close) - wick,
    high: Math.max(open, close) + wick,
  };
}

function minuteBars() {
  if (!Array.isArray(fixture.rows) || fixture.rows.length !== 1_440) {
    throw new Error("expected the complete 1,440-row Binance BTCUSDT 1m volume fixture");
  }
  return fixture.rows.map((row, index) => {
    const [startTime, klineVolumeRaw, , buyVolumeRaw, sellVolumeRaw, tradeCountRaw] = row;
    const volume = Number(klineVolumeRaw);
    const rawBuyVolume = Number(buyVolumeRaw);
    const rawSellVolume = Number(sellVolumeRaw);
    const rawSideVolume = rawBuyVolume + rawSellVolume;
    const buyVolume = rawSideVolume > 0 ? volume * rawBuyVolume / rawSideVolume : volume / 2;
    const sellVolume = volume - buyVolume;
    const tradeCount = Number(tradeCountRaw);
    const buyCount = rawSideVolume > 0
      ? Math.round(tradeCount * rawBuyVolume / rawSideVolume)
      : Math.floor(tradeCount / 2);
    const sellCount = tradeCount - buyCount;
    const { open, close, low, high } = syntheticPriceRange(index);
    const bins = Array.from({ length: high - low + 1 }, (_, binIndex) => low + binIndex);
    const center = (open + close) / 2;
    const weights = bins.map((price, binIndex) => {
      const distance = Math.abs(price - center);
      const sideBias = (index % 2 === 0 ? price >= close : price <= close) ? 1.18 : 1;
      const wickBias = (index % 3 === 0 && (binIndex === 0 || binIndex === bins.length - 1)) ? 1.12 : 1;
      return sideBias * wickBias / ((1 + distance) ** 1.6);
    });
    const totalByBin = splitFloat(volume, weights);
    const buyByBin = splitFloat(buyVolume, weights);
    const buyCountByBin = splitCount(buyCount, weights);
    const sellCountByBin = splitCount(sellCount, weights);
    const cells = new Map(bins.map((priceBin, binIndex) => {
      const cellBuyVolume = buyByBin[binIndex];
      const totalVolume = totalByBin[binIndex];
      return [priceBin, {
        priceBin,
        buyVol: cellBuyVolume,
        sellVol: totalVolume - cellBuyVolume,
        buyCount: buyCountByBin[binIndex],
        sellCount: sellCountByBin[binIndex],
        count: buyCountByBin[binIndex] + sellCountByBin[binIndex],
      }];
    }));
    return {
      startTime,
      open,
      high,
      low,
      close,
      volume,
      delta: buyVolume - sellVolume,
      count: tradeCount,
      cells,
      hasRef: true,
    };
  });
}

function aggregateBars(bars, size) {
  const aggregated = [];
  for (let offset = 0; offset < bars.length; offset += size) {
    const group = bars.slice(offset, offset + size);
    if (group.length !== size) break;
    const cells = new Map();
    for (const bar of group) {
      for (const [price, cell] of bar.cells) {
        const existing = cells.get(price);
        if (existing) {
          existing.buyVol += cell.buyVol;
          existing.sellVol += cell.sellVol;
          existing.buyCount += cell.buyCount;
          existing.sellCount += cell.sellCount;
          existing.count += cell.count;
        } else {
          cells.set(price, { ...cell });
        }
      }
    }
    aggregated.push({
      startTime: group[0].startTime,
      open: group[0].open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group.at(-1).close,
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
      delta: group.reduce((sum, bar) => sum + bar.delta, 0),
      count: group.reduce((sum, bar) => sum + bar.count, 0),
      cells,
      hasRef: true,
    });
  }
  return aggregated;
}

function areaBins(profile, step) {
  if (profile.val === null || profile.vah === null) return new Set();
  const bins = new Set();
  const low = Math.round(profile.val / step);
  const high = Math.round(profile.vah / step);
  for (let bin = low; bin <= high; bin += 1) bins.add(bin);
  return bins;
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / union.size;
}

function profileError(exact, estimated) {
  const exactBins = new Map(exact.levels.map((level) => [level.priceBin, level.totalVol]));
  const estimatedBins = new Map(estimated.levels.map((level) => [level.priceBin, level.totalVol]));
  const prices = new Set([...exactBins.keys(), ...estimatedBins.keys()]);
  const absoluteVolumeError = [...prices].reduce(
    (sum, price) => sum + Math.abs((exactBins.get(price) ?? 0) - (estimatedBins.get(price) ?? 0)),
    0,
  );
  const binDistance = (left, right) => left === null || right === null
    ? null
    : Math.abs(left - right) / priceStep;
  const exactArea = areaBins(exact, priceStep);
  const estimatedArea = areaBins(estimated, priceStep);
  return {
    pocErrorBins: binDistance(exact.poc, estimated.poc),
    vahErrorBins: binDistance(exact.vah, estimated.vah),
    valErrorBins: binDistance(exact.val, estimated.val),
    valueAreaJaccard: jaccard(exactArea, estimatedArea),
    normalizedVolumeError: exact.totalVolume > 0 ? absoluteVolumeError / exact.totalVolume : null,
    exactVolume: exact.totalVolume,
    estimatedVolume: estimated.totalVolume,
  };
}

function calculateRow(bars, resolution, duration) {
  const count = duration.barsByResolution[resolution];
  const selected = bars.slice(0, count);
  const exact = calculateOrderFlowProfile(selected, {
    profileMetric: "volume",
    profileSide: "total",
    priceStep,
  });
  const estimated = calculateOrderFlowProfile(
    selected.map((bar) => ({ ...bar, cells: new Map() })),
    { profileMetric: "volume", profileSide: "total", priceStep, allowOhlcvEstimate: true },
  );
  const error = profileError(exact, estimated);
  if (Math.abs(error.exactVolume - error.estimatedVolume) > Math.max(1e-8, error.exactVolume * 1e-10)) {
    throw new Error(`${resolution}/${duration.label}: volume conservation failed (${error.exactVolume} vs ${error.estimatedVolume})`);
  }
  return { resolution, window: duration.label, bars: count, ...error };
}

const rawBars = minuteBars();
const barsByResolution = {
  "1m": rawBars,
  "5m": aggregateBars(rawBars, 5),
  "1h": aggregateBars(rawBars, 60),
};
const rows = Object.entries(barsByResolution).flatMap(([resolution, bars]) =>
  durations.map((duration) => calculateRow(bars, resolution, duration)));

console.log("PROFILE_ACCURACY_BENCHMARK source=synthetic-price-ladder-on-official-binance-btcusdt-1m-volume-fixture priceStep=1");
console.log("| Resolution | Window | Bars | POC error (bins) | VAH error (bins) | VAL error (bins) | VA Jaccard | Normalized volume L1 |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  console.log(`| ${row.resolution} | ${row.window} | ${row.bars} | ${row.pocErrorBins} | ${row.vahErrorBins} | ${row.valErrorBins} | ${(row.valueAreaJaccard * 100).toFixed(1)}% | ${(row.normalizedVolumeError * 100).toFixed(1)}% |`);
}
console.log(`PROFILE_ACCURACY_BENCHMARK_JSON ${JSON.stringify(rows)}`);
