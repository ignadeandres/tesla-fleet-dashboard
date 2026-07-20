import { ensureFreshToken } from "./oauth.js";

export function createTeslaClient(db, teslaConfig) {
  const client = {
    async call(vehicleId, path, options = {}) {
      const accessToken = await ensureFreshToken(db, vehicleId, teslaConfig);
      const resp = await fetch(`${teslaConfig.apiBase}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!resp.ok) throw new Error(`Tesla API error ${resp.status}: ${path}`);
      return resp.json();
    },

    getVehicleState(vehicleId, teslaVehicleId) {
      return client.call(vehicleId, `/api/1/vehicles/${teslaVehicleId}/vehicle_data`);
    },

    getVehicleLite(vehicleId, teslaVehicleId) {
      return client.call(vehicleId, `/api/1/vehicles/${teslaVehicleId}`);
    },

    wakeVehicle(vehicleId, teslaVehicleId) {
      return client.call(vehicleId, `/api/1/vehicles/${teslaVehicleId}/wake_up`, { method: "POST" });
    },
  };

  return client;
}

// Used only right after exchangeAuthCode, before any vehicle row exists in the DB —
// lists the Tesla account's vehicles with a raw (not-yet-persisted) access token.
export async function fetchTeslaVehicles(accessToken, teslaConfig) {
  const resp = await fetch(`${teslaConfig.apiBase}/api/1/vehicles`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Fetch vehicles failed: ${resp.status}`);
  const data = await resp.json();
  return data.response;
}
