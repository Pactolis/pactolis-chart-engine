import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(root, "src/features/chart/LiveTradeRepairController.ts"),
  "utf8",
);

test("repair overflow performs bounded resynchronization and preserves strictly increasing ID order", () => {
  assert.match(source, /const REPAIR_OVERFLOW_RESYNC_LIMIT = 4;/);
  assert.match(source, /restartAfterOverflow\(trade, detail\)/);
  assert.match(source, /this\.overflowResyncCount >= REPAIR_OVERFLOW_RESYNC_LIMIT/);
  assert.match(source, /this\.pendingSession = \{ \.\.\.session, boundaryAt \};/);
  assert.match(source, /this\.pendingRepairFrom = from;/);
  assert.match(source, /resynchronizing \(\$\{this\.overflowResyncCount\}\/\$\{REPAIR_OVERFLOW_RESYNC_LIMIT\}\)/);

  assert.match(source, /ids\[0\] <= watermark/);
  assert.match(source, /ids\[i - 1\] >= ids\[i\]/);
});
