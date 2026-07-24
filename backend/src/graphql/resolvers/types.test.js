import test from "node:test";
import assert from "node:assert/strict";
import { efficiencyKmPerPercent } from "./types.js";

test("efficiencyKmPerPercent divides distance by battery % consumed", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: 80, endBatteryLevel: 70 }), 4);
});

test("efficiencyKmPerPercent returns null when battery levels are missing", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: null, endBatteryLevel: 70 }), null);
});

test("efficiencyKmPerPercent returns null when net usage isn't positive", () => {
  assert.equal(efficiencyKmPerPercent({ distanceKm: 40, startBatteryLevel: 70, endBatteryLevel: 75 }), null);
});
