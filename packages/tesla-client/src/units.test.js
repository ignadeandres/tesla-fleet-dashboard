import test from "node:test";
import assert from "node:assert/strict";
import { toKm, isMilesUnit } from "./units.js";

test("isMilesUnit detects mi/hr and is case-insensitive", () => {
  assert.equal(isMilesUnit({ gui_settings: { gui_distance_units: "mi/hr" } }), true);
  assert.equal(isMilesUnit({ gui_settings: { gui_distance_units: "MI/HR" } }), true);
  assert.equal(isMilesUnit({ gui_settings: { gui_distance_units: "km/hr" } }), false);
  assert.equal(isMilesUnit({}), false);
});

test("toKm converts only when the car is set to miles, and passes nulls through", () => {
  const milesRaw = { gui_settings: { gui_distance_units: "mi/hr" } };
  const kmRaw = { gui_settings: { gui_distance_units: "km/hr" } };
  assert.ok(Math.abs(toKm(100, milesRaw) - 160.9344) < 1e-9);
  assert.equal(toKm(100, kmRaw), 100);
  assert.equal(toKm(null, milesRaw), null);
});
