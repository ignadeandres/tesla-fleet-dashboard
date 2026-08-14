import test from "node:test";
import assert from "node:assert/strict";
import { runStateMachine, getPollInterval } from "./stateMachine.js";

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

test("getPollInterval polls fast right after the vehicle was last driving/charging, to catch a short follow-up trip", async () => {
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const dbRecentlyActive = { query: async () => ({ rows: [{ ts: oneMinuteAgo }] }) };
  const interval = await getPollInterval(dbRecentlyActive, "veh-1", "online");
  assert.equal(interval, 90 * 1000, "should use the short fast-follow interval, not the 15-minute idle one");
});

test("getPollInterval backs off to the normal idle interval once the vehicle has been parked a while", async () => {
  const overAnHourAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const dbLongParked = { query: async () => ({ rows: [{ ts: overAnHourAgo }] }) };
  const dbNeverActive = { query: async () => ({ rows: [] }) };
  assert.equal(await getPollInterval(dbLongParked, "veh-1", "online"), 15 * 60 * 1000);
  assert.equal(await getPollInterval(dbNeverActive, "veh-1", "online"), 15 * 60 * 1000);
});

test("getPollInterval doesn't touch the fixed driving/charging/asleep intervals", async () => {
  const dbUnused = { query: async () => assert.fail("should not query for a known driving/charging/asleep state") };
  assert.equal(await getPollInterval(dbUnused, "veh-1", "driving"), 60 * 1000);
  assert.equal(await getPollInterval(dbUnused, "veh-1", "charging"), 5 * 60 * 1000);
  assert.equal(await getPollInterval(dbUnused, "veh-1", "asleep"), 10 * 60 * 1000);
});
