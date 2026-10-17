// The slice of an options GEX surface the GEX wall indicator draws, and the strike
// rows it ranks. The app's options contracts satisfy these shapes structurally.

export type GexExposureMode = "gross" | "net";

export interface GexWallStrike {
  strike: number;
  callGrossGexUsd: number;
  putGrossGexUsd: number;
  inferredNetGexUsd?: number;
}

export interface GexWallZone {
  priceLow: number;
  priceHigh: number;
  confidence: number;
}

export interface GexWallSurface {
  spotPrice: number;
  strikes: GexWallStrike[];
  strikeNetGexCrossing: number | null;
  strikeNetGexCrossingZone?: GexWallZone | null;
  callWall: number | null;
  putWall: number | null;
  callWallZone?: GexWallZone | null;
  putWallZone?: GexWallZone | null;
  maxPain: number | null;
}

export interface GexWallRow {
  strike: number;
  callValueUsd: number;
  putValueUsd: number;
  netValueUsd: number;
  callWidthPct: number;
  putWidthPct: number;
  active: boolean;
}

export function buildGexWallRows(surface: GexWallSurface, mode: GexExposureMode, limit = 8): GexWallRow[] {
  const sorted = surface.strikes
    .slice()
    .sort((a, b) => Math.abs(valueForStrike(b, mode)) - Math.abs(valueForStrike(a, mode)))
    .slice(0, Math.max(1, limit));
  const max = Math.max(1, ...sorted.flatMap((strike) => [
    Math.abs(mode === "net" ? Math.max(0, valueForStrike(strike, mode)) : strike.callGrossGexUsd),
    Math.abs(mode === "net" ? Math.min(0, valueForStrike(strike, mode)) : strike.putGrossGexUsd),
  ]));
  return sorted.map((strike) => {
    const net = valueForStrike(strike, mode);
    const callValue = mode === "net" ? Math.max(0, net) : strike.callGrossGexUsd;
    const putValue = mode === "net" ? Math.min(0, net) : -Math.abs(strike.putGrossGexUsd);
    return {
      strike: strike.strike,
      callValueUsd: callValue,
      putValueUsd: putValue,
      netValueUsd: net,
      callWidthPct: Math.min(100, Math.abs(callValue) / max * 100),
      putWidthPct: Math.min(100, Math.abs(putValue) / max * 100),
      active: Math.abs(strike.strike - surface.spotPrice) <= Math.max(surface.spotPrice * 0.01, 1),
    };
  });
}

function valueForStrike(strike: GexWallStrike, mode: GexExposureMode): number {
  return mode === "net"
    ? finite(strike.inferredNetGexUsd)
    : finite(strike.callGrossGexUsd) + finite(strike.putGrossGexUsd);
}

function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
