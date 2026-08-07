import { getVehiclesByUserId } from "../../db/queries/vehicles.js";
import { getLatestSnapshot, getStateLog } from "../../db/queries/telemetry.js";
import { getTripsByVehicle, getTripById, getTripPoints } from "../../db/queries/trips.js";
import { getChargingSessionsByVehicle } from "../../db/queries/charging.js";
import { DEMO_EMAIL } from "../../demo/context.js";

export const User = {
  // Derived from the resolved user itself, not ctx.isDemo — ctx is built once per
  // request before any mutation runs, so it can't reflect the user a login/register
  // mutation just resolved in the same request.
  isDemo: (user) => user.email === DEMO_EMAIL,
  vehicles: (user, _, ctx) => getVehiclesByUserId(ctx.db, user.id),
};

export const Vehicle = {
  latestSnapshot: (vehicle, _, ctx) => getLatestSnapshot(ctx.db, vehicle.id),
  trips: (vehicle, { limit, offset }, ctx) => getTripsByVehicle(ctx.db, vehicle.id, limit, offset),
  trip: (vehicle, { id }, ctx) => getTripById(ctx.db, vehicle.id, id),
  chargingSessions: (vehicle, { limit, offset }, ctx) =>
    getChargingSessionsByVehicle(ctx.db, vehicle.id, limit, offset),
  stateLog: (vehicle, { from, to }, ctx) => getStateLog(ctx.db, vehicle.id, from, to),
};

export function efficiencyKmPerPercent({ distanceKm, startBatteryLevel, endBatteryLevel }) {
  if (distanceKm == null || startBatteryLevel == null || endBatteryLevel == null) return null;
  const used = startBatteryLevel - endBatteryLevel;
  if (used <= 0) return null;
  return distanceKm / used;
}

// Same flat estimate ChargingSession.energyAddedKwh uses (packages/tesla-client/src/charging.js),
// applied to the battery drop instead of the gain — not Tesla's own energy telemetry.
export function energyUsedKwh({ startBatteryLevel, endBatteryLevel }) {
  if (startBatteryLevel == null || endBatteryLevel == null) return null;
  const used = startBatteryLevel - endBatteryLevel;
  if (used <= 0) return null;
  const batteryCapacityKwh = Number(process.env.BATTERY_CAPACITY_KWH || 75);
  return (used / 100) * batteryCapacityKwh;
}

export const Trip = {
  route: (trip, _, ctx) => getTripPoints(ctx.db, trip.id),
  efficiencyKmPerPercent,
  energyUsedKwh,
};
