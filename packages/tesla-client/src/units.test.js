import test from "node:test";
import assert from "node:assert/strict";
import { toKm } from "./units.js";

test("toKm always converts mi->km (confirmed against a real vehicle's odometer)", () => {
  // 21230.153791 stored (raw, unconverted) vs. 34167 actual km on the car's own dash.
  assert.ok(Math.abs(toKm(21230.153791) - 34167) < 1, `expected ~34167, got ${toKm(21230.153791)}`);
});

test("toKm passes null/undefined through unchanged", () => {
  assert.equal(toKm(null), null);
  assert.equal(toKm(undefined), undefined);
});
