export async function saveSnapshot(db, vehicleId, { state, ts, raw }) {
  const d = raw || {};
  const vehicleState = d.vehicle_state || {};
  const chargeState = d.charge_state || {};
  const driveState = d.drive_state || {};
  const climateState = d.climate_state || {};

  await db.query(
    `INSERT INTO telemetry_snapshots
     (vehicle_id, ts, state, battery_level, battery_range, speed, lat, lng,
      heading, odometer, software_version, locked, climate_on, inside_temp,
      outside_temp, door_state, window_state, tire_pressure, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      vehicleId,
      ts,
      state,
      chargeState.battery_level ?? null,
      chargeState.battery_range ?? null,
      driveState.speed ?? null,
      driveState.latitude ?? null,
      driveState.longitude ?? null,
      driveState.heading ?? null,
      vehicleState.odometer ?? null,
      vehicleState.car_version ?? null,
      vehicleState.locked ?? null,
      climateState.is_climate_on ?? null,
      climateState.inside_temp ?? null,
      climateState.outside_temp ?? null,
      JSON.stringify({
        df: vehicleState.df,
        dr: vehicleState.dr,
        pf: vehicleState.pf,
        pr: vehicleState.pr,
      }),
      JSON.stringify({
        fd: vehicleState.fd_window,
        fp: vehicleState.fp_window,
        rd: vehicleState.rd_window,
        rp: vehicleState.rp_window,
      }),
      JSON.stringify(vehicleState.tpms_pressure || {}),
      JSON.stringify(raw || {}),
    ]
  );
}
