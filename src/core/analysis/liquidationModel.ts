export interface LiquidationModelBar {
  t: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tb: number;
  oi: number;
}

export interface LiquidationModelParams {
  lev: number[];
  lw: number[];
  mmr: number;
  bw: number;
  p0: number;
  nbk: number;
}

export interface LiquidationModelV1Summary {
  passed: boolean;
  tested: boolean;
  fallingBp: number;
  risingBp: number;
  bestPlaceboBp: number;
  days: number;
}

export interface LiquidationModelStatePayload {
  schemaVersion: number;
  modelVersion: number;
  symbol: string;
  params: LiquidationModelParams;
  asOf: number;
  lastOi: number;
  longb: string | number[];
  shortb: string | number[];
  v1: LiquidationModelV1Summary;
  seam: LiquidationModelBar[];
}

export interface LiquidationModelStepResult {
  liqL: number;
  liqS: number;
  dOi: number;
}

export interface LiquidationModelBook {
  p0: number;
  bw: number;
  lastClose: number;
  centers: number[];
  longUsd: number[];
  shortUsd: number[];
}

export interface SeamCheckResult {
  status: "ok" | "shifted" | "seam-mismatch";
  shiftSlots: -1 | 0 | 1;
  correctedBars: LiquidationModelBar[];
  overlapCount: number;
}

export interface LiquidationModelInstance {
  step(bar: LiquidationModelBar): LiquidationModelStepResult;
  stepWithDoi(bar: LiquidationModelBar, dOi: number): LiquidationModelStepResult;
  book(): LiquidationModelBook;
  readonly p0: number;
  readonly nbk: number;
  readonly lastClose: number;
  readonly lastOi: number;
}

const STEP_MS = 300_000;

export function decodeF32LeBase64(encoded: string): Float64Array {
  if (!encoded) return new Float64Array(0);
  const binary = atob(encoded);
  const len = binary.length;
  if (len % 4 !== 0) {
    throw new Error(`Invalid f32 base64 byte length: ${len}`);
  }
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = len / 4;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export function encodeF32LeBase64(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) {
    view.setFloat32(i * 4, values[i] ?? 0, true);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function decodeBuckets(raw: string | number[], expectedLen: number): Float64Array {
  const decoded = typeof raw === "string" ? decodeF32LeBase64(raw) : Float64Array.from(raw);
  if (expectedLen > 0 && decoded.length !== expectedLen) {
    const out = new Float64Array(expectedLen);
    out.set(decoded.subarray(0, Math.min(decoded.length, expectedLen)));
    return out;
  }
  return decoded;
}

function isValidBar(bar: LiquidationModelBar): boolean {
  return (
    Number.isFinite(bar.c) && bar.c > 0
    && Number.isFinite(bar.h) && bar.h > 0
    && Number.isFinite(bar.l) && bar.l > 0
    && Number.isFinite(bar.v) && bar.v > 0
  );
}

export function createLiquidationModel(state: LiquidationModelStatePayload): LiquidationModelInstance {
  const { params } = state;
  if (!params || !Array.isArray(params.lev) || !Array.isArray(params.lw) || params.lev.length === 0) {
    throw new Error("LiquidationModel requires non-empty params.lev and params.lw");
  }
  if (params.lev.length !== params.lw.length) {
    throw new Error("LiquidationModel params.lev and params.lw length mismatch");
  }
  if (!Number.isFinite(params.bw) || params.bw <= 0 || !Number.isFinite(params.p0) || params.p0 <= 0) {
    throw new Error("LiquidationModel requires positive finite params.bw and params.p0");
  }

  const lev = params.lev.slice();
  const lw = params.lw.slice();
  const mmr = params.mmr;
  const bw = params.bw;
  let p0 = params.p0;

  const lfac = lev.map((l) => 1 - 1 / l + mmr);
  const sfac = lev.map((l) => 1 + 1 / l - mmr);

  let prevLastClose = 1;
  if (Array.isArray(state.seam)) {
    for (let i = state.seam.length - 1; i >= 0; i -= 1) {
      const c = state.seam[i]?.c;
      if (Number.isFinite(c) && c > 0) {
        prevLastClose = c;
        break;
      }
    }
  }

  const rawLongUsd = decodeBuckets(state.longb, params.nbk);
  const rawShortUsd = decodeBuckets(state.shortb, params.nbk);
  let longb = new Float64Array(rawLongUsd.length);
  let shortb = new Float64Array(rawShortUsd.length);
  for (let i = 0; i < rawLongUsd.length; i += 1) {
    longb[i] = rawLongUsd[i] / prevLastClose;
  }
  for (let i = 0; i < rawShortUsd.length; i += 1) {
    shortb[i] = rawShortUsd[i] / prevLastClose;
  }

  let lastClose = prevLastClose;
  let lastOi = Number.isFinite(state.lastOi) && state.lastOi > 0 ? state.lastOi : 0;
  if (lastOi <= 0 && Array.isArray(state.seam)) {
    for (let i = state.seam.length - 1; i >= 0; i -= 1) {
      const oi = state.seam[i]?.oi;
      if (Number.isFinite(oi) && oi > 0) {
        lastOi = oi;
        break;
      }
    }
  }

  const bucketIndex = (price: number): number => Math.floor(Math.log(price / p0) / bw);

  const ensureBucket = (price: number): number => {
    const idx = bucketIndex(price);
    if (idx < 0) {
      const prepend = -idx;
      const newLong = new Float64Array(longb.length + prepend);
      newLong.set(longb, prepend);
      longb = newLong;

      const newShort = new Float64Array(shortb.length + prepend);
      newShort.set(shortb, prepend);
      shortb = newShort;

      p0 *= Math.exp(-prepend * bw);
      return 0;
    }
    if (idx >= longb.length) {
      const newLen = idx + 1;
      const newLong = new Float64Array(newLen);
      newLong.set(longb);
      longb = newLong;

      const newShort = new Float64Array(newLen);
      newShort.set(shortb);
      shortb = newShort;
    }
    return idx;
  };

  const stepWithDoi = (bar: LiquidationModelBar, dOi: number): LiquidationModelStepResult => {
    if (!isValidBar(bar)) {
      return { liqL: 0, liqS: 0, dOi: 0 };
    }
    lastClose = bar.c;

    const nbk = longb.length;
    let liqL = 0;
    const jl = bucketIndex(bar.l);
    if (jl < nbk) {
      const start = Math.max(0, jl);
      for (let i = start; i < nbk; i += 1) {
        liqL += longb[i];
        longb[i] = 0;
      }
    }

    let liqS = 0;
    const js = bucketIndex(bar.h) + 1;
    if (js > 0) {
      const end = Math.min(js, nbk);
      for (let i = 0; i < end; i += 1) {
        liqS += shortb[i];
        shortb[i] = 0;
      }
    }

    const rawB = bar.tb / bar.v;
    const b = Number.isFinite(rawB) ? Math.min(1, Math.max(0, rawB)) : 0.5;

    if (dOi > 0) {
      const pe = (bar.h + bar.l + bar.c) / 3;
      for (let k = 0; k < lev.length; k += 1) {
        const w = lw[k];
        const lp = pe * lfac[k];
        if (lp > 0 && Number.isFinite(lp)) {
          const idx = ensureBucket(lp);
          longb[idx] += dOi * b * w;
        }
        const sp = pe * sfac[k];
        if (sp > 0 && Number.isFinite(sp)) {
          const idx = ensureBucket(sp);
          shortb[idx] += dOi * (1 - b) * w;
        }
      }
    } else if (dOi < 0) {
      const rem = Math.min(0, dOi + liqL + liqS);
      if (rem < 0) {
        const amtL = -rem * (1 - b);
        let totL = 0;
        for (let i = 0; i < longb.length; i += 1) totL += longb[i];
        if (totL > 0) {
          const scale = Math.max(0, 1 - amtL / totL);
          for (let i = 0; i < longb.length; i += 1) longb[i] *= scale;
        }

        const amtS = -rem * b;
        let totS = 0;
        for (let i = 0; i < shortb.length; i += 1) totS += shortb[i];
        if (totS > 0) {
          const scale = Math.max(0, 1 - amtS / totS);
          for (let i = 0; i < shortb.length; i += 1) shortb[i] *= scale;
        }
      }
    }

    return { liqL, liqS, dOi };
  };

  const step = (bar: LiquidationModelBar): LiquidationModelStepResult => {
    const validOi = Number.isFinite(bar.oi) && bar.oi > 0;
    const dOi = lastOi > 0 && validOi ? bar.oi - lastOi : 0;
    if (validOi) {
      lastOi = bar.oi;
    }
    return stepWithDoi(bar, dOi);
  };

  const book = (): LiquidationModelBook => {
    const n = longb.length;
    const centers = new Array<number>(n);
    const longUsd = new Array<number>(n);
    const shortUsd = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      centers[i] = p0 * Math.exp((i + 0.5) * bw);
      longUsd[i] = longb[i] * lastClose;
      shortUsd[i] = shortb[i] * lastClose;
    }
    return { p0, bw, lastClose, centers, longUsd, shortUsd };
  };

  return {
    step,
    stepWithDoi,
    book,
    get p0() {
      return p0;
    },
    get nbk() {
      return longb.length;
    },
    get lastClose() {
      return lastClose;
    },
    get lastOi() {
      return lastOi;
    },
  };
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / denom;
}

export function checkSeamAndDetectShift(
  seamBars: readonly LiquidationModelBar[],
  restBars: readonly LiquidationModelBar[],
): SeamCheckResult {
  if (seamBars.length === 0) {
    return { status: "ok", shiftSlots: 0, correctedBars: restBars.slice(), overlapCount: 0 };
  }
  if (restBars.length === 0) {
    return { status: "seam-mismatch", shiftSlots: 0, correctedBars: [], overlapCount: 0 };
  }

  const restByT = new Map<number, LiquidationModelBar>();
  for (const bar of restBars) {
    restByT.set(bar.t, bar);
  }

  let overlapCount = 0;
  let priceMatchCount = 0;
  const shiftMatches: Record<-1 | 0 | 1, { matched: number; compared: number }> = {
    0: { matched: 0, compared: 0 },
    1: { matched: 0, compared: 0 },
    [-1]: { matched: 0, compared: 0 },
  };

  for (const sBar of seamBars) {
    const rSame = restByT.get(sBar.t);
    if (!rSame) continue;
    overlapCount += 1;
    if (relDiff(sBar.c, rSame.c) <= 1e-3) {
      priceMatchCount += 1;
    }
    if (!Number.isFinite(sBar.oi) || sBar.oi <= 0) continue;

    for (const shift of [0, 1, -1] as const) {
      const rShifted = restByT.get(sBar.t + shift * STEP_MS);
      if (!rShifted || !Number.isFinite(rShifted.oi) || rShifted.oi <= 0) continue;
      shiftMatches[shift].compared += 1;
      if (relDiff(sBar.oi, rShifted.oi) <= 1e-3) {
        shiftMatches[shift].matched += 1;
      }
    }
  }

  if (overlapCount === 0 || priceMatchCount / overlapCount < 0.9) {
    return { status: "seam-mismatch", shiftSlots: 0, correctedBars: [], overlapCount };
  }

  const rate0 = shiftMatches[0].compared > 0 ? shiftMatches[0].matched / shiftMatches[0].compared : 0;
  if (shiftMatches[0].compared > 0 && rate0 >= 0.9) {
    return { status: "ok", shiftSlots: 0, correctedBars: restBars.slice(), overlapCount };
  }

  const ratePlus = shiftMatches[1].compared > 0 ? shiftMatches[1].matched / shiftMatches[1].compared : 0;
  const rateMinus = shiftMatches[-1].compared > 0 ? shiftMatches[-1].matched / shiftMatches[-1].compared : 0;

  let bestShift: -1 | 1 | null = null;
  if (shiftMatches[1].compared > 0 && ratePlus >= 0.9 && ratePlus >= rateMinus) {
    bestShift = 1;
  } else if (shiftMatches[-1].compared > 0 && rateMinus >= 0.9) {
    bestShift = -1;
  }

  if (bestShift !== null) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn(
        `[liquidationModel] Detected ${bestShift * 5}m (${bestShift} slot) OI shift in seam; correcting REST bars.`,
      );
    }
    const correctedBars = restBars.map((bar) => {
      const shifted = restByT.get(bar.t + bestShift * STEP_MS);
      return shifted && Number.isFinite(shifted.oi) && shifted.oi > 0
        ? { ...bar, oi: shifted.oi }
        : { ...bar };
    });
    return { status: "shifted", shiftSlots: bestShift, correctedBars, overlapCount };
  }

  return { status: "seam-mismatch", shiftSlots: 0, correctedBars: [], overlapCount };
}
