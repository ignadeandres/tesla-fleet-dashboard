const SELECT_FIELDS = `
  id, start_time AS "startTime", end_time AS "endTime",
  distance_km AS "distanceKm", duration_seconds AS "durationSeconds",
  start_lat AS "startLat", start_lng AS "startLng",
  end_lat AS "endLat", end_lng AS "endLng"
`;

export async function getTripsByVehicle(db, vehicleId, limit = 50, offset = 0) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM trips WHERE vehicle_id = $1
     ORDER BY start_time DESC LIMIT $2 OFFSET $3`,
    [vehicleId, limit, offset]
  );
  return rows;
}

// vehicleId-scoped so a trip id from another user's vehicle can't be looked up here —
// the caller (Vehicle.trip resolver) already has an ownership-checked parent Vehicle.
export async function getTripById(db, vehicleId, tripId) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM trips WHERE vehicle_id = $1 AND id = $2`,
    [vehicleId, tripId]
  );
  return rows[0] || null;
}

export async function getTripPoints(db, tripId) {
  const { rows } = await db.query(
    `SELECT ts, lat, lng, speed FROM trip_points WHERE trip_id = $1 ORDER BY ts ASC`,
    [tripId]
  );
  return rows;
}
