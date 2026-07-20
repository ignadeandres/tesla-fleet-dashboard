import { gql } from "@apollo/client";

export const VEHICLE_STATE_LOG_QUERY = gql`
  query VehicleStateLog($id: ID!, $from: DateTime, $to: DateTime) {
    vehicle(id: $id) {
      stateLog(from: $from, to: $to) {
        ts
        state
        batteryLevel
        batteryRange
        odometer
        locked
        climateOn
        insideTemp
        outsideTemp
        doorState
        windowState
      }
    }
  }
`;
