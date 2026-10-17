import assert from "node:assert/strict";
import test from "node:test";

import { BoundedCache } from "../dist/core/cache/boundedCache.js";

test("BoundedCache evicts least-recently-used entries", () => {
  let now = 1_000;
  const cache = new BoundedCache({ maxEntries: 2, ttlMs: 1_000, now: () => now });
  cache.set("a", 1);
  now += 1;
  cache.set("b", 2);
  now += 1;
  assert.equal(cache.get("a"), 1);
  now += 1;
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("BoundedCache expires errors faster and prunes request families", () => {
  let now = 2_000;
  const cache = new BoundedCache({ maxEntries: 8, ttlMs: 1_000, errorTtlMs: 100, now: () => now });
  cache.set("family|old", "old");
  cache.set("other|keep", "keep");
  cache.set("error", "boom", "error");
  cache.pruneFamily("family|new", (key) => key.startsWith("family|"));
  assert.equal(cache.get("family|old"), undefined);
  assert.equal(cache.get("other|keep"), "keep");
  now += 101;
  assert.equal(cache.get("error"), undefined);
});

// TASK: "transient" (e.g. a {status:"loading"} placeholder) must not silently
// inherit the full success TTL — that would leave a hung request's placeholder
// cached, and therefore returned, for as long as a real result would be.
test("BoundedCache expires transient entries on their own short default TTL, distinct from ready", () => {
  let now = 3_000;
  const cache = new BoundedCache({ maxEntries: 8, ttlMs: 15 * 60_000, now: () => now });
  cache.set("loading", { status: "loading" }, "transient");
  cache.set("ready", { status: "ready" });
  now += 20_001; // just past the default transient TTL (20s), nowhere near the 15min ready TTL
  assert.equal(cache.get("loading"), undefined);
  assert.deepEqual(cache.get("ready"), { status: "ready" });
});

test("BoundedCache honors a per-instance transientTtlMs override", () => {
  let now = 4_000;
  const cache = new BoundedCache({ maxEntries: 8, ttlMs: 1_000, transientTtlMs: 50, now: () => now });
  cache.set("loading", "placeholder", "transient");
  now += 51;
  assert.equal(cache.get("loading"), undefined);
});
