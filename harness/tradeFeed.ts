// Live trades for load specs. It reads the JSON "trades" frames a trade gateway
// sends (one message per batch, normalized trades with an instrument symbol) and
// hands each trade to the charts subscribed to its market, in order. It does no
// reconnects, sequencing or catalog routing: those belong to the host
// application's transport, not the engine.
import type { AggTrade } from "../src/core/types.js";

interface WireTrade {
  instrument: string;
  tradeId: string;
  exchangeTimestamp: number;
  price: number;
  quantity: number;
  side: "buy" | "sell";
  tradeCount?: number;
  liquidation?: boolean;
  source?: { session?: string; sequence?: number };
}

export class TradeFeed {
  private readonly listeners = new Map<string, Set<(trade: AggTrade) => void>>();

  /** @param exchange Prefix that turns an instrument into a market, e.g. BINANCE_FUTURES. */
  constructor(private readonly exchange = "BINANCE_FUTURES") {}

  subscribe(market: string, cb: (trade: AggTrade) => void): () => void {
    let set = this.listeners.get(market);
    if (!set) this.listeners.set(market, set = new Set());
    set.add(cb);
    return () => { set.delete(cb); };
  }

  /** Read one raw gateway frame. Frames other than "trades" are ignored. */
  receive(raw: string): void {
    const frame = JSON.parse(raw) as { type?: string; trades?: WireTrade[] };
    if (frame.type !== "trades" || !Array.isArray(frame.trades)) return;
    const receivedAt = Date.now();
    for (const wire of frame.trades) {
      const market = `${this.exchange}:${wire.instrument.toLowerCase()}`;
      const set = this.listeners.get(market);
      if (!set?.size) continue;
      const trade: AggTrade = {
        time: wire.exchangeTimestamp,
        price: wire.price,
        qty: wire.quantity,
        tradeCount: wire.tradeCount,
        isBuy: wire.side === "buy",
        liquidation: wire.liquidation,
        market,
        id: wire.tradeId,
        source: "live",
        receivedAt,
        sourceSession: wire.source?.session,
        sourceSequence: wire.source?.sequence,
      };
      for (const cb of set) cb(trade);
    }
  }
}
