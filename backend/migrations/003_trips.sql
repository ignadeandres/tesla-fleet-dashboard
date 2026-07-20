CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lng DOUBLE PRECISION,
  distance_km NUMERIC,
  duration_seconds INTEGER
);

CREATE TABLE trip_points (
  id BIGSERIAL PRIMARY KEY,
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  speed NUMERIC
);

CREATE INDEX idx_trip_points_trip ON trip_points (trip_id, ts);
