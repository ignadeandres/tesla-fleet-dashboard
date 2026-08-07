-- Enforces at most one open trip / open charging session per vehicle at the DB level.
-- Needed now that both the worker poller and the backend's refreshVehicle mutation can
-- call handleTripPoint/handleChargingUpdate concurrently for the same vehicle — without
-- this, a race between the two lets both insert a new "open" row before either commits.
CREATE UNIQUE INDEX idx_trips_vehicle_open ON trips (vehicle_id) WHERE end_time IS NULL;
CREATE UNIQUE INDEX idx_charging_sessions_vehicle_open ON charging_sessions (vehicle_id) WHERE end_time IS NULL;
