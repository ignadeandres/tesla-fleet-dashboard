import test from "node:test";
import assert from "node:assert/strict";
import { totalDistanceKm, handleTripPoint, closeTripIfOpen } from "./trip.js";

test("totalDistanceKm is 0 for fewer than 2 points", () => {
  assert.equal(totalDistanceKm([]), 0);
  assert.equal(totalDistanceKm([{ lat: 41.38, lng: 2.17 }]), 0);
});

test("totalDistanceKm sums consecutive point-to-point distances (Barcelona, ~1.8km apart)", () => {
  // Plaça Catalunya -> Sagrada Família, roughly 1.8km apart as the crow flies.
  const points = [
    { lat: 41.3870, lng: 2.1701 },
    { lat: 41.4036, lng: 2.1744 },
  ];
  const km = totalDistanceKm(points);
  assert.ok(km > 1.5 && km < 2.5, `expected ~1.8km, got ${km}`);
});

// A db whose every query throws: any DB access at all fails the test.
const noDb = { query: () => { throw new Error("should not touch the DB"); } };

test("handleTripPoint skips a payload with no coordinates (trip_points.lat/lng are NOT NULL)", async () => {
  await handleTripPoint(noDb, "veh-1", { drive_state: { shift_state: "D" }, charge_state: {} });
});

test("closeTripIfOpen leaves the trip alone when drive_state is missing entirely", async () => {
  await closeTripIfOpen(noDb, "veh-1", { charge_state: { battery_level: 50 } });
});
