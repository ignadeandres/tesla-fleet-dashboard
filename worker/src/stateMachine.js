import { saveSnapshot } from "./handlers/snapshot.js";
import { handleTripPoint, closeTripIfOpen } from "./handlers/trip.js";
import { handleChargingUpdate, closeChargingSessionIfOpen } from "./handlers/charging.js";

// Per-vehicle last-poll bookkeeping (in-memory; resets on worker restart, acceptable for v1)
const lastPollAt = new Map();

const INTERVALS_MS = {
  asleep: 60 * 60 * 1000,
  idle: 15 * 60 * 1000,
  driving: 60 * 1000,
  charging: 5 * 60 * 1000,
};

export async function runStateMachine(db, tesla, vehicle) {
  const now = Date.now();
  const last = lastPollAt.get(vehicle.id) || 0;

  const { rows } = await db.query(
    `SELECT state FROM telemetry_snapshots WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicle.id]
  );
  const knownState = rows[0]?.state || "idle";
  const interval = INTERVALS_MS[knownState] || INTERVALS_MS.idle;

  if (now - last < interval) return; // not due yet

  // Lightweight, non-waking check first
  const lite = await tesla.getVehicleLite(vehicle.id, vehicle.tesla_vehicle_id);
  if (lite.response?.state === "asleep") {
    lastPollAt.set(vehicle.id, now);
    await saveSnapshot(db, vehicle.id, { state: "asleep", ts: new Date() });
    return;
  }

  // Full poll (safe: vehicle already awake)
  const full = await tesla.getVehicleState(vehicle.id, vehicle.tesla_vehicle_id);
  const data = full.response;

  const driving = ["D", "R", "N"].includes(data.drive_state?.shift_state) || data.drive_state?.speed > 0;
  const charging = data.charge_state?.charging_state === "Charging";
  const state = driving ? "driving" : charging ? "charging" : "online";

  await saveSnapshot(db, vehicle.id, { state, ts: new Date(), raw: data });

  if (driving) {
    await handleTripPoint(db, vehicle.id, data);
  } else {
    await closeTripIfOpen(db, vehicle.id, data);
  }
  if (charging) {
    await handleChargingUpdate(db, vehicle.id, data);
  } else {
    await closeChargingSessionIfOpen(db, vehicle.id, data);
  }

  lastPollAt.set(vehicle.id, now);
}
