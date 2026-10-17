import test from "node:test";
import assert from "node:assert/strict";
import { volumeProfileIndicatorDefinition } from "../dist/features/indicators/builtins/volumeProfile.js";

test("legacy indicator type is retained with the new visible name and flow category", () => {
  assert.equal(volumeProfileIndicatorDefinition.type, "volume-profile");
  assert.equal(volumeProfileIndicatorDefinition.name, "Order Flow Profile");
  assert.equal(volumeProfileIndicatorDefinition.category, "flow");
});

test("new defaults retain volume total and static level behavior", () => {
  const settings = volumeProfileIndicatorDefinition.defaultSettings();
  assert.equal(settings.mode, "visible");
  assert.equal(settings.profileMetric, "volume");
  assert.equal(settings.profileSide, "total");
  assert.equal(settings.pocMode, "static");
  assert.equal(settings.vahMode, "static");
  assert.equal(settings.valMode, "static");
});

test("metric, side, range and independent level controls are represented in the schema", () => {
  const fields = volumeProfileIndicatorDefinition.settingsSchema.sections.flatMap((section) => section.fields);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  assert.deepEqual(byKey.get("profileMetric").options.map((item) => item.value), [
    "volume", "delta", "trade-count", "average-trade-size",
  ]);
  assert.deepEqual(byKey.get("profileSide").options.map((item) => item.value), ["total", "buy", "sell"]);
  assert.deepEqual(byKey.get("mode").options.map((item) => item.value), ["visible", "session", "lookback"]);
  for (const key of ["pocMode", "vahMode", "valMode"]) {
    assert.deepEqual(byKey.get(key).options.map((item) => item.value), ["off", "static", "developing", "both"]);
  }
  assert.deepEqual(byKey.get("profileSide").visibleWhen, { key: "profileMetric", notValues: ["delta"] });
  assert.deepEqual(byKey.get("lookbackBars").visibleWhen, { key: "mode", values: ["lookback"] });
});

test("unsupported metrics hide every POC and value-area control without erasing settings", () => {
  const fields = volumeProfileIndicatorDefinition.settingsSchema.sections.flatMap((section) => section.fields);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const supportedOnly = { key: "profileMetric", values: ["volume", "trade-count"] };
  const levelKeys = [
    "valueAreaPercent", "pocMode", "vahMode", "valMode",
    "pocStaticColor", "pocStaticWidth", "pocStaticStyle",
    "pocDevelopingColor", "pocDevelopingWidth", "pocDevelopingStyle",
    "vahStaticColor", "vahStaticWidth", "vahStaticStyle",
    "vahDevelopingColor", "vahDevelopingWidth", "vahDevelopingStyle",
    "valStaticColor", "valStaticWidth", "valStaticStyle",
    "valDevelopingColor", "valDevelopingWidth", "valDevelopingStyle",
  ];
  for (const key of levelKeys) assert.deepEqual(byKey.get(key).visibleWhen, supportedOnly, key);
});
