import { gql } from "@apollo/client";

export const VEHICLE_TRIPS_QUERY = gql`
  query VehicleTrips($id: ID!, $limit: Int, $offset: Int) {
    vehicle(id: $id) {
      trips(limit: $limit, offset: $offset) {
        id
        startTime
        endTime
        distanceKm
        durationSeconds
        startLat
        startLng
        endLat
        endLng
      }
    }
  }
`;

// Route (GPS breadcrumb) is fetched lazily per selected trip, not inline on the list
// query above — a trip list of 30 would otherwise trigger 30 route fetches up front.
export const TRIP_ROUTE_QUERY = gql`
  query TripRoute($vehicleId: ID!, $tripId: ID!) {
    vehicle(id: $vehicleId) {
      trip(id: $tripId) {
        id
        route {
          ts
          lat
          lng
          speed
        }
      }
    }
  }
`;
