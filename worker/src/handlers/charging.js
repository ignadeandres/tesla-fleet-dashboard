const openSessions = new Map();

export async function handleChargingUpdate(db, vehicleId, data) {
  const chargeState = data.charge_state || {};
  const driveState = data.drive_state || {};
  const ts = new Date();

  let session = openSessions.get(vehicleId);
  if (!session) {
    const { rows } = await db.query(
      `INSERT INTO charging_sessions (vehicle_id, start_time, start_battery_level, lat, lng)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [vehicleId, ts, chargeState.battery_level, driveState.latitude, driveState.longitude]
    );
    session = { id: rows[0].id };
    openSessions.set(vehicleId, session);
  }
  // Update running end_battery_level on every poll while charging continues
  await db.query(
    `UPDATE charging_sessions SET end_battery_level = $1 WHERE id = $2`,
    [chargeState.battery_level, session.id]
  );
}

export async function closeChargingSessionIfOpen(db, vehicleId, data) {
  const session = openSessions.get(vehicleId);
  if (!session) return;

  const chargeState = data.charge_state || {};
  const { rows } = await db.query(
    `SELECT start_battery_level FROM charging_sessions WHERE id = $1`,
    [session.id]
  );
  const startLevel = rows[0]?.start_battery_level ?? 0;
  const endLevel = chargeState.battery_level ?? startLevel;
  // Rough kWh estimate: (% gained / 100) * battery capacity (75 kWh default for Model 3 LR — adjust as needed)
  const batteryCapacityKwh = Number(process.env.BATTERY_CAPACITY_KWH || 75);
  const energyAdded = ((endLevel - startLevel) / 100) * batteryCapacityKwh;

  await db.query(
    `UPDATE charging_sessions SET end_time = $1, end_battery_level = $2, energy_added_kwh = $3
     WHERE id = $4`,
    [new Date(), endLevel, energyAdded, session.id]
  );

  openSessions.delete(vehicleId);
}
