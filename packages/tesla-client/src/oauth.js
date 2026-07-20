export async function ensureFreshToken(db, vehicleId, teslaConfig) {
  const { rows } = await db.query(
    `SELECT access_token, refresh_token, expires_at FROM vehicle_tokens WHERE vehicle_id = $1`,
    [vehicleId]
  );
  const token = rows[0];
  if (!token) throw new Error(`No token found for vehicle ${vehicleId}`);

  const now = new Date();
  const bufferMs = 5 * 60 * 1000; // refresh 5 min before actual expiry

  if (new Date(token.expires_at).getTime() - bufferMs > now.getTime()) {
    return token.access_token; // still valid
  }

  const resp = await fetch(`${teslaConfig.authBase}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: teslaConfig.clientId,
      refresh_token: token.refresh_token,
    }),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const data = await resp.json();

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);
  await db.query(
    `UPDATE vehicle_tokens SET access_token = $1, refresh_token = $2, expires_at = $3 WHERE vehicle_id = $4`,
    [data.access_token, data.refresh_token, newExpiresAt, vehicleId]
  );

  return data.access_token;
}
