export async function getChargingSessionsByVehicle(db, vehicleId, limit = 50, offset = 0) {
  const { rows } = await db.query(
    `SELECT id, start_time AS "startTime", end_time AS "endTime",
            start_battery_level AS "startBatteryLevel", end_battery_level AS "endBatteryLevel",
            energy_added_kwh AS "energyAddedKwh", lat, lng
     FROM charging_sessions WHERE vehicle_id = $1
     ORDER BY start_time DESC LIMIT $2 OFFSET $3`,
    [vehicleId, limit, offset]
  );
  return rows;
}
