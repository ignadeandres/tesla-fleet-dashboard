import { toKm } from "tesla-client";

// Tracks an open trip per vehicle in-memory; persists points as they arrive,
// closes the trip row once driving stops. Simple v1 approach — acceptable
// since worker restarts are infrequent and a lost in-progress trip just
// means one incomplete trip row, not data corruption.
const openTrips = new Map();

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

export async function handleTripPoint(db, vehicleId, data) {
  const driveState = data.drive_state || {};
  const lat = driveState.latitude;
  const lng = driveState.longitude;
  const speed = toKm(driveState.speed);
  const ts = new Date();

  let trip = openTrips.get(vehicleId);
  if (!trip) {
    const { rows } = await db.query(
      `INSERT INTO trips (vehicle_id, start_time, start_lat, start_lng)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [vehicleId, ts, lat, lng]
    );
    trip = { id: rows[0].id, startTime: ts };
    openTrips.set(vehicleId, trip);
  }

  await db.query(
    `INSERT INTO trip_points (trip_id, ts, lat, lng, speed) VALUES ($1,$2,$3,$4,$5)`,
    [trip.id, ts, lat, lng, speed]
  );
}

export async function closeTripIfOpen(db, vehicleId, data) {
  const trip = openTrips.get(vehicleId);
  if (!trip) return;

  const driveState = data.drive_state || {};
  const endTime = new Date();
  const durationSeconds = Math.round((endTime - trip.startTime) / 1000);

  const { rows } = await db.query(
    `SELECT lat, lng FROM trip_points WHERE trip_id = $1 ORDER BY ts ASC`,
    [trip.id]
  );
  const distanceKm = totalDistanceKm(rows);

  await db.query(
    `UPDATE trips SET end_time = $1, end_lat = $2, end_lng = $3, duration_seconds = $4, distance_km = $5
     WHERE id = $6`,
    [endTime, driveState.latitude, driveState.longitude, durationSeconds, distanceKm, trip.id]
  );

  openTrips.delete(vehicleId);
}
