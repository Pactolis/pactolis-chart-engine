# Real Binance minute-volume fixture

`binance-btcusdt-2026-11-10-1m.json` retains all 1,440 BTCUSDT minute side volumes/counts from official Binance Vision futures/um daily archives:

- https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2026-11-10.zip
- https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-11-10.zip

Both ZIPs were verified against adjacent official CHECKSUM files; hashes are pinned in JSON. This is the same decimal-reduced fixture used in backend #447. Buy volume uses `is_buyer_maker=false`; sell volume uses `true`. Trade counts are independent upstream measures. Daily volumes both equal 167583.171 BTC.

The test supplies neutral price coordinates, not a reconstructed real price ladder. It verifies coverage decisions and downstream level existence; it makes no claim about actual historical VAL/VAH/POC prices.

A relative period tolerance of 1e-6 (absolute floor 1e-12) accepts this complete day without any extra edge allowance. Larger period deficits and surpluses are rejected. Explicit `partial`/`provisional` bars remain ineligible for footprint levels; partial cells do not invalidate canonical OHLC levels.
