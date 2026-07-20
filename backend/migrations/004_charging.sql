CREATE TABLE charging_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  start_battery_level SMALLINT,
  end_battery_level SMALLINT,
  energy_added_kwh NUMERIC,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION
);
