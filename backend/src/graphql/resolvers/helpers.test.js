import test from "node:test";
import assert from "node:assert/strict";
import { GraphQLError } from "graphql";
import { requireOwnedVehicle } from "./helpers.js";

function fakeDb(vehicleRow) {
  return { query: async () => ({ rows: vehicleRow ? [vehicleRow] : [] }) };
}

test("requireOwnedVehicle returns the vehicle when the requester owns it", async () => {
  const db = fakeDb({ id: "v1", userId: "u1", vin: "VIN1" });
  const vehicle = await requireOwnedVehicle({ db, user: { id: "u1" } }, "v1");
  assert.equal(vehicle.id, "v1");
});

test("requireOwnedVehicle throws NOT_FOUND for another user's vehicle", async () => {
  const db = fakeDb({ id: "v1", userId: "u1", vin: "VIN1" });
  await assert.rejects(
    () => requireOwnedVehicle({ db, user: { id: "someone-else" } }, "v1"),
    (err) => err instanceof GraphQLError && err.extensions.code === "NOT_FOUND"
  );
});

test("requireOwnedVehicle throws UNAUTHENTICATED with no user in context", async () => {
  const db = fakeDb({ id: "v1", userId: "u1", vin: "VIN1" });
  await assert.rejects(
    () => requireOwnedVehicle({ db, user: null }, "v1"),
    (err) => err instanceof GraphQLError && err.extensions.code === "UNAUTHENTICATED"
  );
});
