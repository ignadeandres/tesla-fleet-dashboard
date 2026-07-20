// Tracks an open trip per vehicle in-memory; persists points as they arrive,
// closes the trip row once driving stops. Simple v1 approach — acceptable
// since worker restarts are infrequent and a lost in-progress trip just
// means one incomplete trip row, not data corruption.
const openTrips = new Map();

export async function handleTripPoint(db, vehicleId, data) {
  const driveState = data.drive_state || {};
  const lat = driveState.latitude;
  const lng = driveState.longitude;
  const speed = driveState.speed;
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
    `SELECT lat, lng FROM trip_points WHERE trip_id = $1 ORDER BY ts ASC LIMIT 1`,
    [trip.id]
  );
  const start = rows[0] || {};

  await db.query(
    `UPDATE trips SET end_time = $1, end_lat = $2, end_lng = $3, duration_seconds = $4
     WHERE id = $5`,
    [endTime, driveState.latitude, driveState.longitude, durationSeconds, trip.id]
  );

  openTrips.delete(vehicleId);
}
