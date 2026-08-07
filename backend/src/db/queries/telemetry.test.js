import test from "node:test";
import assert from "node:assert/strict";
import { getLatestSnapshot } from "./telemetry.js";

function makeFakeDb({ latest, fallback }) {
  return {
    query: async (sql) => {
      if (sql.includes("odometer IS NOT NULL")) return { rows: fallback ? [fallback] : [] };
      return { rows: latest ? [latest] : [] };
    },
  };
}

test("returns the latest row as-is when it already has telemetry", async () => {
  const db = makeFakeDb({ latest: { state: "driving", ts: "t2", odometer: 100 } });
  const snap = await getLatestSnapshot(db, "v1");
  assert.deepEqual(snap, { state: "driving", ts: "t2", odometer: 100 });
});

test("falls back to the last real reading when the latest row is a bare asleep marker, keeping the fresh state/ts", async () => {
  const db = makeFakeDb({
    latest: { state: "asleep", ts: "t2", odometer: null, batteryLevel: null },
    fallback: { state: "driving", ts: "t1", odometer: 100, batteryLevel: 80 },
  });
  const snap = await getLatestSnapshot(db, "v1");
  assert.equal(snap.state, "asleep");
  assert.equal(snap.ts, "t2");
  assert.equal(snap.odometer, 100);
  assert.equal(snap.batteryLevel, 80);
});

test("backfills odometer/locked from the last full reading when a poll comes back charge_state-only, but keeps fresh battery/state/ts", async () => {
  // Mirrors Tesla's real behavior: vehicle_state/drive_state/climate_state are absent
  // from the API response while the car's MCU sleeps mid-charge, so battery_level is
  // fresh but odometer/locked are null on the latest row.
  const db = makeFakeDb({
    latest: { state: "charging", ts: "t2", odometer: null, batteryLevel: 29, locked: null },
    fallback: { state: "charging", ts: "t1", odometer: 34493.9, batteryLevel: 47, locked: true },
  });
  const snap = await getLatestSnapshot(db, "v1");
  assert.equal(snap.ts, "t2");
  assert.equal(snap.state, "charging");
  assert.equal(snap.batteryLevel, 29);
  assert.equal(snap.odometer, 34493.9);
  assert.equal(snap.locked, true);
});

test("returns the bare asleep row when there's no prior reading at all", async () => {
  const db = makeFakeDb({ latest: { state: "asleep", ts: "t1", odometer: null } });
  const snap = await getLatestSnapshot(db, "v1");
  assert.equal(snap.state, "asleep");
  assert.equal(snap.odometer, null);
});

test("returns null when there's no snapshot yet", async () => {
  const db = makeFakeDb({});
  assert.equal(await getLatestSnapshot(db, "v1"), null);
});
