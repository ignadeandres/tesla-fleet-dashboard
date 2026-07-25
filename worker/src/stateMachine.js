import { saveSnapshot } from "./handlers/snapshot.js";
import { handleTripPoint, closeTripIfOpen } from "./handlers/trip.js";
import { handleChargingUpdate, closeChargingSessionIfOpen } from "./handlers/charging.js";

// Per-vehicle last-full-poll bookkeeping (in-memory; resets on worker restart, acceptable for v1)
const lastPollAt = new Map();

// Only throttles the expensive, vehicle-data full poll. The lite check below is
// cheap and non-waking, so it always runs every tick regardless of these — that's
// what catches a sleep -> awake transition promptly instead of missing it for up
// to an hour (a full "asleep" gate used to also gate the lite check itself, so a
// short drive starting from "asleep" could complete before the worker ever looked).
const INTERVALS_MS = {
  idle: 15 * 60 * 1000,
  driving: 60 * 1000,
  charging: 5 * 60 * 1000,
};

export async function runStateMachine(db, tesla, vehicle) {
  const now = Date.now();

  const { rows } = await db.query(
    `SELECT state FROM telemetry_snapshots WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicle.id]
  );
  const knownState = rows[0]?.state || "idle";

  // Lightweight, non-waking check every tick.
  const lite = await tesla.getVehicleLite(vehicle.id, vehicle.tesla_vehicle_id);
  if (lite.response?.state === "asleep") {
    // Only record the transition once — not on every tick it stays asleep, which
    // would otherwise spam null-telemetry rows over the whole sleep period.
    if (knownState !== "asleep") await saveSnapshot(db, vehicle.id, { state: "asleep", ts: new Date() });
    return;
  }

  // Awake. Throttle the expensive full poll to the state-based interval — except
  // right after waking (knownState still "asleep"), where we don't yet know the
  // real state and should check now rather than wait out a stale interval.
  const last = lastPollAt.get(vehicle.id) || 0;
  const interval = knownState === "asleep" ? 0 : INTERVALS_MS[knownState] || INTERVALS_MS.idle;
  if (now - last < interval) return; // not due yet

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
