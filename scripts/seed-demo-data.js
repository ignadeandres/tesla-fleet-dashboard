import pg from "pg";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const DEMO_EMAIL = "demo@tesla-fleet-dashboard.dev";
const DEMO_PASSWORD = "demo1234"; // demo-only credential, documented in README

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING`,
      [userId, DEMO_EMAIL, passwordHash]
    );
    const { rows: userRows } = await client.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
    const realUserId = userRows[0].id;

    const vehicleId = randomUUID();
    await client.query(
      `INSERT INTO vehicles (id, user_id, tesla_vehicle_id, vin, display_name, model)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (vin) DO NOTHING`,
      [vehicleId, realUserId, 999999999, "DEMOVIN0000000001", "Demo Model 3", "Model 3"]
    );
    const { rows: vRows } = await client.query(`SELECT id FROM vehicles WHERE vin = 'DEMOVIN0000000001'`);
    const realVehicleId = vRows[0].id;

    const now = new Date();
    const baseLat = 41.3874, baseLng = 2.1686;
    let battery = 80;

    for (let i = 7 * 24 * 4; i >= 0; i--) {
      const ts = new Date(now.getTime() - i * 15 * 60 * 1000);
      const hour = ts.getHours();
      const charging = hour >= 2 && hour <= 6;
      battery += charging ? 1.2 : -0.15;
      battery = Math.max(20, Math.min(100, battery));

      await client.query(
        `INSERT INTO telemetry_snapshots
         (vehicle_id, ts, state, battery_level, battery_range, speed, lat, lng,
          heading, odometer, software_version, locked, climate_on, inside_temp,
          outside_temp, door_state, window_state, tire_pressure)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          realVehicleId,
          ts,
          charging ? "charging" : "online",
          Math.round(battery),
          Math.round(battery * 4.1),
          0,
          baseLat + (Math.random() - 0.5) * 0.002,
          baseLng + (Math.random() - 0.5) * 0.002,
          Math.floor(Math.random() * 360),
          12000 + i * 0.3,
          "2024.20.9",
          true,
          false,
          21,
          Math.round(15 + Math.random() * 10),
          JSON.stringify({ df: false, dr: false, pf: false, pr: false }),
          JSON.stringify({ fd: false, fp: false, rd: false, rp: false }),
          JSON.stringify({ fl: 42, fr: 42, rl: 42, rr: 42 }),
        ]
      );
    }

    for (let t = 0; t < 5; t++) {
      const startTime = new Date(now.getTime() - t * 26 * 60 * 60 * 1000);
      const endTime = new Date(startTime.getTime() + 25 * 60 * 1000);
      const tripId = randomUUID();
      const startLat = baseLat, startLng = baseLng;
      const endLat = baseLat + 0.03, endLng = baseLng + 0.04;

      await client.query(
        `INSERT INTO trips (id, vehicle_id, start_time, end_time, start_lat, start_lng,
                             end_lat, end_lng, distance_km, duration_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tripId, realVehicleId, startTime, endTime, startLat, startLng, endLat, endLng, 6.4, 1500]
      );

      const points = 15;
      for (let p = 0; p <= points; p++) {
        const frac = p / points;
        await client.query(
          `INSERT INTO trip_points (trip_id, ts, lat, lng, speed) VALUES ($1,$2,$3,$4,$5)`,
          [
            tripId,
            new Date(startTime.getTime() + frac * (endTime - startTime)),
            startLat + frac * (endLat - startLat) + (Math.random() - 0.5) * 0.001,
            startLng + frac * (endLng - startLng) + (Math.random() - 0.5) * 0.001,
            30 + Math.random() * 40,
          ]
        );
      }
    }

    for (let c = 0; c < 3; c++) {
      const startTime = new Date(now.getTime() - c * 48 * 60 * 60 * 1000);
      const endTime = new Date(startTime.getTime() + 3.5 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO charging_sessions
         (id, vehicle_id, start_time, end_time, start_battery_level, end_battery_level,
          energy_added_kwh, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), realVehicleId, startTime, endTime, 35, 90, 34.5, baseLat, baseLng]
      );
    }

    await client.query("COMMIT");
    console.log(`Demo data seeded. Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
