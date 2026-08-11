import {
  saveSnapshot,
  handleTripPoint,
  closeTripIfOpen,
  handleChargingUpdate,
  closeChargingSessionIfOpen,
} from "tesla-client";
import { checkAndConsumeBudget } from "./apiBudget.js";

// Per-vehicle last-poll bookkeeping (in-memory; resets on worker restart, acceptable for v1)
const lastPollAt = new Map();

// Every branch below costs a billed Fleet API call (even the "lite" one), so a single
// gate covers both the lite and full poll. asleep is intentionally short (not the old
// 60-minute gate) so a short drive starting from "asleep" is still caught reasonably
// fast, but no longer unthrottled — that unthrottled version is what blew past Tesla's
// Fleet API billing limit (up to 1,440 calls/day/vehicle just for the lite check).
const INTERVALS_MS = {
  asleep: 10 * 60 * 1000,
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

  const last = lastPollAt.get(vehicle.id) || 0;
  const interval = INTERVALS_MS[knownState] || INTERVALS_MS.idle;
  if (now - last < interval) return; // not due yet
  lastPollAt.set(vehicle.id, now);

  // Hard daily ceiling on billed calls (see apiBudget.js) — independent backstop
  // in case the intervals above ever aren't enough to stay under the Fleet API
  // billing limit.
  if (!(await checkAndConsumeBudget(db))) {
    console.warn(`[stateMachine] daily Tesla API call budget exhausted, skipping vehicle ${vehicle.id}`);
    return;
  }

  // Lightweight, non-waking check first — avoids waking the car with a full poll.
  const lite = await tesla.getVehicleLite(vehicle.id, vehicle.tesla_vehicle_id);
  // Gate on "online" rather than on "asleep": Tesla also reports "offline" and "waking",
  // and vehicle_data answers 408 for every one of those, burning a billed call and
  // aborting the tick before the trip/charging handlers below ever run.
  const liteState = lite.response?.state || "unknown";
  if (liteState !== "online") {
    // Only record the transition once — not on every tick it stays down, which would
    // otherwise spam null-telemetry rows over the whole sleep/outage period.
    if (knownState !== liteState) await saveSnapshot(db, vehicle.id, { state: liteState, ts: new Date() });
    return;
  }

  if (!(await checkAndConsumeBudget(db))) {
    console.warn(`[stateMachine] daily Tesla API call budget exhausted, skipping full poll for vehicle ${vehicle.id}`);
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
}
