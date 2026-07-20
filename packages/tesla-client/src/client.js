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
  };

  return client;
}
