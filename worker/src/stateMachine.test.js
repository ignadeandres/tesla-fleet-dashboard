import test from "node:test";
import assert from "node:assert/strict";
import { runStateMachine } from "./stateMachine.js";

function makeFakeDb(knownState) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("SELECT state FROM telemetry_snapshots")) {
        return { rows: knownState ? [{ state: knownState }] : [] };
      }
      if (sql.includes("RETURNING id")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

test("a vehicle last recorded asleep polls on the very first tick, instead of waiting out a stale interval", async () => {
  const db = makeFakeDb("asleep");
  const tesla = {
    getVehicleLite: async () => ({ response: { state: "online" } }),
    getVehicleState: async () => ({
      response: {
        drive_state: { shift_state: "D", speed: 30, latitude: 1, longitude: 2 },
        charge_state: { battery_level: 50 },
      },
    }),
  };
  await runStateMachine(db, tesla, { id: "veh-wake", tesla_vehicle_id: "t1" });
  assert.ok(
    db.calls.some((sql) => sql.includes("INSERT INTO trips")),
    "expected a trip to start on the first poll for a never-before-seen vehicle"
  );
});

test("a vehicle that's still asleep only records the transition once, not on every tick", async () => {
  const db = makeFakeDb("asleep");
  const tesla = {
    getVehicleLite: async () => ({ response: { state: "asleep" } }),
    getVehicleState: async () => {
      throw new Error("should never do a full poll while the vehicle is still asleep");
    },
  };
  await runStateMachine(db, tesla, { id: "veh-asleep", tesla_vehicle_id: "t1" });
  assert.ok(
    !db.calls.some((sql) => sql.includes("INSERT INTO telemetry_snapshots")),
    "knownState is already asleep — should not re-insert a redundant asleep snapshot"
  );
});

test("an idle-awake vehicle throttles repeated polls (lite and full) to the idle interval", async () => {
  const db = makeFakeDb("idle");
  let liteCalls = 0;
  let fullPollCalls = 0;
  const tesla = {
    getVehicleLite: async () => {
      liteCalls++;
      return { response: { state: "online" } };
    },
    getVehicleState: async () => {
      fullPollCalls++;
      return { response: { drive_state: {}, charge_state: {} } };
    },
  };
  const vehicle = { id: "veh-idle-throttle", tesla_vehicle_id: "t1" };
  await runStateMachine(db, tesla, vehicle);
  await runStateMachine(db, tesla, vehicle);
  assert.equal(liteCalls, 1, "the second tick is within the idle interval — no API call at all, not even the lite one");
  assert.equal(fullPollCalls, 1, "the expensive full poll should be throttled on the second tick");
});
