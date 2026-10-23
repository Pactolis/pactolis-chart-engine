// Remembers which trades with a plain numeric ID a footprint series applied recently.
import type { AggTrade } from "../types.js";

const BUY_FLAG = 1;
const LIQUIDATION_FLAG = 2;
/** Doubles kept per row: time, price, quantity and trade count. */
const FIELDS = 4;
const INITIAL_ROWS = 1_024;

/** Side and liquidation flag of a trade, the two bits `identifiedPayload` ends with. */
export function payloadFlags(trade: AggTrade): number {
  return (trade.isBuy ? BUY_FLAG : 0) | (trade.liquidation ? LIQUIDATION_FLAG : 0);
}

/** The IDs one market has applied recently, each pointing at the row that holds the rest of its trade. */
export interface MarketTradeIds {
  readonly market: string;
  /** Whether this market's IDs only grow, so an evicted one can raise a pruning floor. */
  readonly monotonic: boolean;
  readonly rows: Map<number, number>;
}

/**
 * The dedup memory for trades whose ID is a plain decimal number. A market's IDs are the keys
 * of a number-keyed map, and the payload each ID was first delivered with sits in shared typed
 * arrays, so remembering a trade allocates neither a string nor an object. The arrays keep the
 * size of their busiest moment until `clear`.
 */
export class RecentTradeIds {
  private readonly markets = new Map<string, MarketTradeIds | null>();
  /** The market asked for last: trades come in runs from one market, which spares a lookup. */
  private lastMarket: string | undefined;
  private lastIds: MarketTradeIds | null = null;
  /** Row `r` keeps time, price, quantity and trade count at `fields[r * FIELDS]` on, and its flags at `flags[r]`. */
  private fields = new Float64Array(0);
  private flags = new Uint8Array(0);
  /** Rows handed out so far; the ones below it that no ID points at wait in `freed`. */
  private used = 0;
  private readonly freed: number[] = [];
  private held = 0;

  /** @param isMonotonic whether the trade IDs of a market only grow */
  constructor(private readonly isMonotonic: (market: string) => boolean) {}

  /** Trades remembered. */
  get size(): number { return this.held; }

  /**
   * The IDs kept for `market`, or null when its identities stay fingerprint strings. A
   * fingerprint joins market and ID with `|`, so a market that contains one can spell the same
   * fingerprint as another market's ID; such a market stays with the fingerprints, where those
   * collisions resolve as they always did.
   */
  idsFor(market: string): MarketTradeIds | null {
    if (market === this.lastMarket) return this.lastIds;
    if (typeof market !== "string") return null;
    let ids = this.markets.get(market);
    if (ids === undefined) {
      ids = market.includes("|") ? null : { market, monotonic: this.isMonotonic(market), rows: new Map() };
      this.markets.set(market, ids);
    }
    this.lastMarket = market;
    this.lastIds = ids;
    return ids;
  }

  /** Whether the trade remembered in `row` has the payload of `trade`. */
  matches(row: number, trade: AggTrade): boolean {
    const fields = this.fields;
    const at = row * FIELDS;
    return fields[at] === trade.time
      && fields[at + 1] === trade.price
      && fields[at + 2] === trade.qty
      && fields[at + 3] === (trade.tradeCount ?? 1)
      && this.flags[row] === payloadFlags(trade);
  }

  /** Remember `trade` under `id`, which `ids` must not hold yet. */
  add(ids: MarketTradeIds, id: number, trade: AggTrade): void {
    let row = this.freed.pop();
    if (row === undefined) {
      if (this.used === this.flags.length) this.grow();
      row = this.used++;
    }
    const at = row * FIELDS;
    this.fields[at] = trade.time;
    this.fields[at + 1] = trade.price;
    this.fields[at + 2] = trade.qty;
    this.fields[at + 3] = trade.tradeCount ?? 1;
    this.flags[row] = payloadFlags(trade);
    ids.rows.set(id, row);
    this.held++;
  }

  /**
   * Forget every trade with a time before `cutoff`, wherever it sits. For each market whose IDs
   * only grow, `raiseFloor` hears the highest ID forgotten from among its normal trades,
   * since those were applied and any ID at or below it is a late re-delivery.
   */
  evictBefore(cutoff: number, raiseFloor: (market: string, id: number) => void): void {
    const fields = this.fields;
    for (const ids of this.markets.values()) {
      if (ids === null) continue;
      let highest = -1;
      for (const [id, row] of ids.rows) {
        if (fields[row * FIELDS] >= cutoff) continue;
        ids.rows.delete(id);
        this.freed.push(row);
        this.held--;
        if (ids.monotonic && (this.flags[row] & LIQUIDATION_FLAG) === 0 && id > highest) highest = id;
      }
      if (highest >= 0) raiseFloor(ids.market, highest);
    }
  }

  clear(): void {
    this.markets.clear();
    this.lastMarket = undefined;
    this.lastIds = null;
    this.fields = new Float64Array(0);
    this.flags = new Uint8Array(0);
    this.used = 0;
    this.freed.length = 0;
    this.held = 0;
  }

  private grow(): void {
    const rows = Math.max(INITIAL_ROWS, this.flags.length * 2);
    const fields = new Float64Array(rows * FIELDS);
    fields.set(this.fields);
    const flags = new Uint8Array(rows);
    flags.set(this.flags);
    this.fields = fields;
    this.flags = flags;
  }
}
