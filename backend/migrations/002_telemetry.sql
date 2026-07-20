CREATE TABLE telemetry_snapshots (
  id BIGSERIAL PRIMARY KEY,
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  state TEXT,
  battery_level SMALLINT,
  battery_range NUMERIC,
  speed NUMERIC,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  heading SMALLINT,
  odometer NUMERIC,
  software_version TEXT,
  locked BOOLEAN,
  climate_on BOOLEAN,
  inside_temp NUMERIC,
  outside_temp NUMERIC,
  door_state JSONB,
  window_state JSONB,
  tire_pressure JSONB,
  raw JSONB
);

CREATE INDEX idx_telemetry_vehicle_ts ON telemetry_snapshots (vehicle_id, ts DESC);
