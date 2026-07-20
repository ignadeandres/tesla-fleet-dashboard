export async function insertVehicleTokens(db, vehicleId, { accessToken, refreshToken, expiresAt }) {
  await db.query(
    `INSERT INTO vehicle_tokens (vehicle_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (vehicle_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at`,
    [vehicleId, accessToken, refreshToken, expiresAt]
  );
}
