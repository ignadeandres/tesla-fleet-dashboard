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
  if (!latest || latest.odometer != null) return latest || null;

  // odometer missing covers two different partial-poll cases: a bare state-transition
  // marker (e.g. going asleep) writes no telemetry at all, and a full poll can also
  // come back with only charge_state populated — Tesla's own API omits vehicle_state/
  // drive_state/climate_state whenever the car's main computer sleeps while the BMS
  // keeps charging and stays responsive, which happens on most overnight charges.
  // Either way, backfill each missing field from the most recent row that had it,
  // while trusting `latest` for state/ts always and for any field it did get fresh
  // (e.g. battery_level/battery_range, which come from charge_state and are present
  // even when the rest of the poll is empty).
  const { rows: fallbackRows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM telemetry_snapshots
     WHERE vehicle_id = $1 AND odometer IS NOT NULL ORDER BY ts DESC LIMIT 1`,
    [vehicleId]
  );
  const fallback = fallbackRows[0];
  if (!fallback) return latest;

  const merged = { state: latest.state, ts: latest.ts };
  for (const key of Object.keys(fallback)) {
    if (key === "state" || key === "ts") continue;
    merged[key] = latest[key] != null ? latest[key] : fallback[key];
  }
  return merged;
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
