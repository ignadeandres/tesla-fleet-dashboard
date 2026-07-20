import { gql } from "@apollo/client";

export const VEHICLE_CHARGING_QUERY = gql`
  query VehicleCharging($id: ID!, $limit: Int, $offset: Int) {
    vehicle(id: $id) {
      chargingSessions(limit: $limit, offset: $offset) {
        id
        startTime
        endTime
        startBatteryLevel
        endBatteryLevel
        energyAddedKwh
        lat
        lng
      }
    }
  }
`;
