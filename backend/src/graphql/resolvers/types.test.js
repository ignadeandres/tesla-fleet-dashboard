import test from "node:test";
import assert from "node:assert/strict";
import { efficiencyKmPerPercent, energyUsedKwh } from "./types.js";

test("efficiencyKmPerPercent divides distance by battery % consumed", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: 80, endBatteryLevel: 70 }), 4);
});

test("efficiencyKmPerPercent returns null when battery levels are missing", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: null, endBatteryLevel: 70 }), null);
});

test("efficiencyKmPerPercent returns null when net usage isn't positive", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: 70, endBatteryLevel: 75 }), null);
});

test("energyUsedKwh applies BATTERY_CAPACITY_KWH to the % consumed", () => {
  const prev = process.env.BATTERY_CAPACITY_KWH;
  process.env.BATTERY_CAPACITY_KWH = "75";
  assert.equal(energyUsedKwh({ startBatteryLevel: 80, endBatteryLevel: 70 }), 7.5);
  process.env.BATTERY_CAPACITY_KWH = prev;
});

test("energyUsedKwh returns null when battery levels are missing", () => {
  assert.equal(energyUsedKwh({ startBatteryLevel: null, endBatteryLevel: 70 }), null);
});

test("energyUsedKwh returns null when net usage isn't positive", () => {
  assert.equal(energyUsedKwh({ startBatteryLevel: 70, endBatteryLevel: 75 }), null);
});
