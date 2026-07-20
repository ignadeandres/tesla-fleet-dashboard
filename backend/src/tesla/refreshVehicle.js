import { createTeslaClient } from "tesla-client";

export function makeRefreshVehicle(db, teslaConfig) {
  const tesla = createTeslaClient(db, teslaConfig);

  return async function refreshVehicle(vehicleId, teslaVehicleId) {
    const full = await tesla.getVehicleState(vehicleId, teslaVehicleId);
    return full.response;
  };
}
