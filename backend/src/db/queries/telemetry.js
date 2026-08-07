export { saveSnapshot as insertSnapshot } from "tesla-client";

const SELECT_FIELDS = `
  ts, state, battery_level AS "batteryLevel", battery_range AS "batteryRange", speed,
  lat, lng, heading, odometer, software_version AS "softwareVersion", locked,
  climate_on AS "climateOn", inside_temp AS "insideTemp", outside_temp AS "outsideTemp",
  door_state AS "doorState", window_state AS "windowState", tire_pressure AS "tirePressure"
`;

export async function getLatestSnapshot(db, vehicleId) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM telemetry_snapshots
     WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  const latest = rows[0];
  // Bare state-transition rows (e.g. going asleep) are written with no charge_state
  // at all, so battery_level is null — unlike a full poll, which always has
  // battery_level even on the (separately tracked) cases where odometer comes back
  // missing. Keying this check on odometer instead would treat every odometer-less
  // full poll as a bare marker and permanently mask it behind old fallback data.
  if (!latest || latest.batteryLevel != null) return latest || null;

  // Fall back to the most recent row that actually had a reading, keeping the
  // fresher state/ts so the UI still shows "Asleep" rather than a stale status.
  const { rows: fallbackRows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM telemetry_snapshots
     WHERE vehicle_id = $1 AND battery_level IS NOT NULL ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  const fallback = fallbackRows[0];
  return fallback ? { ...fallback, state: latest.state, ts: latest.ts } : latest;
}

// Capped even with no from/to — worker polls as often as every 60s while driving and
// retention is permanent, so an unbounded query here grows without limit over the
// vehicle's lifetime. 2000 rows covers ~3 weeks of continuous 1-minute polling.
const MAX_STATE_LOG_ROWS = 2000;

export async function getStateLog(db, vehicleId, from, to) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM telemetry_snapshots
     WHERE vehicle_id = $1
       AND ts >= COALESCE($2::timestamptz, '-infinity') AND ts <= COALESCE($3::timestamptz, 'infinity')
     ORDER BY ts DESC
     LIMIT $4`,
    [vehicleId, from || null, to || null, MAX_STATE_LOG_ROWS]
  );
  return rows;
}
