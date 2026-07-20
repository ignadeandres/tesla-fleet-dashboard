import { gql } from "@apollo/client";

const SNAPSHOT_FIELDS = gql`
  fragment SnapshotFields on TelemetrySnapshot {
    ts
    state
    batteryLevel
    batteryRange
    speed
    lat
    lng
    heading
    odometer
    softwareVersion
    locked
    climateOn
    insideTemp
    outsideTemp
    doorState
    windowState
    tirePressure
  }
`;

export const VEHICLE_OVERVIEW_QUERY = gql`
  ${SNAPSHOT_FIELDS}
  query VehicleOverview($id: ID!) {
    vehicle(id: $id) {
      id
      vin
      displayName
      model
      latestSnapshot {
        ...SnapshotFields
      }
    }
  }
`;

export const REFRESH_VEHICLE_MUTATION = gql`
  ${SNAPSHOT_FIELDS}
  mutation RefreshVehicle($id: ID!) {
    refreshVehicle(id: $id) {
      ...SnapshotFields
    }
  }
`;
