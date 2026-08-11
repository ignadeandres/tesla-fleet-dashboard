import { toKm } from "./units.js";

// Shared by the worker's poller and the backend's manual-refresh mutation — both need
// to open/continue/close the same trip regardless of which process is calling. Open
// trip state is looked up from the DB (end_time IS NULL) rather than kept in memory,
// since a Map would only be visible within whichever process wrote it.

// Sum of haversine distances between consecutive points, in km.
const EARTH_RADIUS_KM = 6371;
function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}
export function totalDistanceKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i]);
  return total;
}

async function getOpenTrip(db, vehicleId) {
  const { rows } = await db.query(
    `SELECT id, start_time FROM trips WHERE vehicle_id = $1 AND end_time IS NULL
     ORDER BY start_time DESC LIMIT 1`,
    [vehicleId]
  );
  return rows[0] || null;
}

export async function handleTripPoint(db, vehicleId, data) {
  const driveState = data.drive_state || {};
  const chargeState = data.charge_state || {};
  const lat = driveState.latitude;
  const lng = driveState.longitude;
  // trip_points.lat/lng are NOT NULL (migration 003), so a payload without coordinates
  // would throw mid-tick and abort everything after it in the caller. Nothing useful to
  // record without a position anyway — skip rather than open a trip we can't plot.
  if (lat == null || lng == null) return;

  const speed = toKm(driveState.speed);
  const ts = new Date();

  let trip = await getOpenTrip(db, vehicleId);
  if (!trip) {
    // ON CONFLICT guards the race between two processes (worker poll + manual refresh)
    // both finding no open trip and inserting at once — see migration 007. The loser's
    // INSERT is skipped and it reads back the winner's row instead.
    const { rows } = await db.query(
      `INSERT INTO trips (vehicle_id, start_time, start_lat, start_lng, start_battery_level)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vehicle_id) WHERE end_time IS NULL DO NOTHING
       RETURNING id, start_time`,
      [vehicleId, ts, lat, lng, chargeState.battery_level ?? null]
    );
    trip = rows[0] || (await getOpenTrip(db, vehicleId));
    if (!trip) return; // conflicting trip was closed between the INSERT and the re-read
  }

  await db.query(
    `INSERT INTO trip_points (trip_id, ts, lat, lng, speed) VALUES ($1,$2,$3,$4,$5)`,
    [trip.id, ts, lat, lng, speed]
  );
}

export async function closeTripIfOpen(db, vehicleId, data) {
  // Callers infer "not driving" from a falsy shift_state, which is indistinguishable from
  // drive_state being absent entirely. Closing on a partial payload would end a live trip
  // with a null end location and a truncated distance, then open a second one next poll.
  if (!data.drive_state) return;

  const trip = await getOpenTrip(db, vehicleId);
  if (!trip) return;

  const driveState = data.drive_state || {};
  const endTime = new Date();
  const durationSeconds = Math.round((endTime - trip.start_time) / 1000);

  const { rows } = await db.query(
    `SELECT lat, lng FROM trip_points WHERE trip_id = $1 ORDER BY ts ASC`,
    [trip.id]
  );
  const distanceKm = totalDistanceKm(rows);
  const chargeState = data.charge_state || {};

  await db.query(
    `UPDATE trips SET end_time = $1, end_lat = $2, end_lng = $3, duration_seconds = $4,
     distance_km = $5, end_battery_level = $6
     WHERE id = $7`,
    [endTime, driveState.latitude, driveState.longitude, durationSeconds, distanceKm,
     chargeState.battery_level ?? null, trip.id]
  );
}
