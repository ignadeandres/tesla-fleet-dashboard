// Shared by the worker's poller and the backend's manual-refresh mutation — see trip.js
// for why open-session state is looked up from the DB (end_time IS NULL) instead of
// an in-memory Map.

async function getOpenSession(db, vehicleId) {
  const { rows } = await db.query(
    `SELECT id, start_battery_level FROM charging_sessions WHERE vehicle_id = $1 AND end_time IS NULL
     ORDER BY start_time DESC LIMIT 1`,
    [vehicleId]
  );
  return rows[0] || null;
}

export async function handleChargingUpdate(db, vehicleId, data) {
  const chargeState = data.charge_state || {};
  const driveState = data.drive_state || {};
  const ts = new Date();

  let session = await getOpenSession(db, vehicleId);
  if (!session) {
    // ON CONFLICT guards the race between two processes (worker poll + manual refresh)
    // both finding no open session and inserting at once — see migration 007. The
    // loser's INSERT is skipped and it reads back the winner's row instead.
    const { rows } = await db.query(
      `INSERT INTO charging_sessions (vehicle_id, start_time, start_battery_level, lat, lng)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (vehicle_id) WHERE end_time IS NULL DO NOTHING
       RETURNING id, start_battery_level`,
      [vehicleId, ts, chargeState.battery_level, driveState.latitude, driveState.longitude]
    );
    session = rows[0] || (await getOpenSession(db, vehicleId));
  }
  // Update running end_battery_level on every poll while charging continues
  await db.query(
    `UPDATE charging_sessions SET end_battery_level = $1 WHERE id = $2`,
    [chargeState.battery_level, session.id]
  );
}

export async function closeChargingSessionIfOpen(db, vehicleId, data) {
  // Same reasoning as closeTripIfOpen: a payload with no charge_state can't tell a
  // finished charge from a partial response, and closing wrongly bakes a bogus
  // end_battery_level and energy_added_kwh into the session.
  if (!data.charge_state) return;

  const session = await getOpenSession(db, vehicleId);
  if (!session) return;

  const chargeState = data.charge_state || {};
  const startLevel = session.start_battery_level ?? 0;
  const endLevel = chargeState.battery_level ?? startLevel;
  // Rough kWh estimate: (% gained / 100) * usable pack capacity. Default matches the
  // deployed vehicle; override with BATTERY_CAPACITY_KWH (set for both services in .env).
  const batteryCapacityKwh = Number(process.env.BATTERY_CAPACITY_KWH || 56);
  const energyAdded = ((endLevel - startLevel) / 100) * batteryCapacityKwh;

  await db.query(
    `UPDATE charging_sessions SET end_time = $1, end_battery_level = $2, energy_added_kwh = $3
     WHERE id = $4`,
    [new Date(), endLevel, energyAdded, session.id]
  );
}
