import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");
const contractRelativePath = "src/features/indicators/indicatorSettingsModalContract.ts";
const managerSource = read("src/features/indicators/IndicatorManager.ts");
const contractSource = existsSync(join(ROOT, contractRelativePath))
  ? readFileSync(join(ROOT, contractRelativePath), "utf8")
  : null;

function requireContract(reason) {
  assert.ok(contractSource, `${reason}: typed IndicatorSettingsModal contract henüz yok`);
  return contractSource ?? "";
}

test("singleton: same-instance reopen focuslar, different instance tek session replace eder", () => {
  const contract = requireContract("singleton/replacement");
  assert.match(contract, /instanceId/);
  assert.match(contract, /focus/);
  assert.match(contract, /replac|dismiss|close/);
  assert.match(managerSource, /activeSettingsSession|settingsModalSession/);
});

test("removeIndicator aktif modal sessionını kapatır ve stale callback no-op olur", () => {
  const contract = requireContract("remove/dispose");
  assert.match(contract, /token|generation|disposed|stale/);
  const removeStart = managerSource.indexOf("private removeIndicator(");
  const removeEnd = managerSource.indexOf("\n  private ", removeStart + 1);
  const removeBody = removeStart >= 0
    ? managerSource.slice(removeStart, removeEnd > removeStart ? removeEnd : removeStart + 1200)
    : "";
  assert.match(
    removeBody,
    /activeSettingsSession|closeSettings|dismiss|openSettingsModals/,
    "removeIndicator active settings session close/invalidation çağırmıyor",
  );
});

test("valid preview ve transient number guard typed command contractında ayrıdır", () => {
  const contract = requireContract("preview guard");
  assert.match(contract, /preview/);
  assert.match(contract, /number|finite|invalid|transient/);
  assert.match(managerSource, /updateSettings/);
});

test("Save final apply+close; Close/Escape/scrim rollback yapmaz", () => {
  const contract = requireContract("save/close semantics");
  assert.match(contract, /save/);
  assert.match(contract, /close|dismiss/);
  assert.match(contract, /escape|scrim|close-button/);
  assert.match(contract, /rollback|noRollback|preserveDraft|apply/);
});

test("dispose ve replacement token guard eski callback'in instance'a yazmasını engeller", () => {
  const contract = requireContract("stale callback");
  assert.match(contract, /instanceId/);
  assert.match(contract, /disposed/);
  assert.match(contract, /token|generation|session/);
  assert.match(managerSource, /dispose\(\)/);
});
