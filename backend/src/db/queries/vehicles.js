const SELECT_FIELDS = `
  id, user_id AS "userId", vin, display_name AS "displayName", model,
  tesla_vehicle_id AS "teslaVehicleId"
`;

export async function getVehicleById(db, id) {
  const { rows } = await db.query(`SELECT ${SELECT_FIELDS} FROM vehicles WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getVehiclesByUserId(db, userId) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM vehicles WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return rows;
}

export async function getVehicleByTeslaVehicleId(db, teslaVehicleId) {
  const { rows } = await db.query(
    `SELECT ${SELECT_FIELDS} FROM vehicles WHERE tesla_vehicle_id = $1`,
    [teslaVehicleId]
  );
  return rows[0] || null;
}

export async function insertVehicle(db, { userId, teslaVehicleId, vin, displayName, model }) {
  const { rows } = await db.query(
    `INSERT INTO vehicles (user_id, tesla_vehicle_id, vin, display_name, model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (vin) DO NOTHING
     RETURNING ${SELECT_FIELDS}`,
    [userId, teslaVehicleId, vin, displayName, model]
  );
  return rows[0] || getVehicleByTeslaVehicleId(db, teslaVehicleId);
}
