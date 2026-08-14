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

// The plain 15-minute idle/online interval above was letting genuinely short trips
// (a quick errand, a few minutes each way) slip through entirely, or be caught only
// once already well underway — nothing detects "driving" until the next tick that
// happens to land during the trip. A follow-up trip is disproportionately likely in
// the few minutes right after the vehicle was last seen driving/charging (the next
// stop on the errand run, heading home, etc.), so poll fast for a while in exactly
// that window, then back off to the normal idle cadence once it's been parked a
// while and a new trip starting imminently is much less likely.
const RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
const FAST_FOLLOW_INTERVAL_MS = 90 * 1000;

export async function getPollInterval(db, vehicleId, knownState) {
  if (knownState === "driving") return INTERVALS_MS.driving;
  if (knownState === "charging") return INTERVALS_MS.charging;
  if (knownState === "asleep") return INTERVALS_MS.asleep;

  const { rows } = await db.query(
    `SELECT ts FROM telemetry_snapshots WHERE vehicle_id = $1 AND state IN ('driving', 'charging')
     ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  const lastActiveAt = rows[0]?.ts ? new Date(rows[0].ts).getTime() : 0;
  if (Date.now() - lastActiveAt < RECENT_ACTIVITY_WINDOW_MS) return FAST_FOLLOW_INTERVAL_MS;
  return INTERVALS_MS.idle;
}

export async function runStateMachine(db, tesla, vehicle) {
  const now = Date.now();

  const { rows } = await db.query(
    `SELECT state FROM telemetry_snapshots WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicle.id]
  );
  const knownState = rows[0]?.state || "idle";

  const last = lastPollAt.get(vehicle.id) || 0;
  const interval = await getPollInterval(db, vehicle.id, knownState);
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
