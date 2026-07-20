import pg from "pg";
import { createTeslaClient } from "tesla-client";
import { runStateMachine } from "./stateMachine.js";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const teslaConfig = {
  apiBase: process.env.TESLA_API_BASE,
  authBase: process.env.TESLA_AUTH_BASE || "https://fleet-auth.prd.vn.cloud.tesla.com",
  clientId: process.env.TESLA_CLIENT_ID,
};

const tesla = createTeslaClient(db, teslaConfig);

async function tick() {
  // Only vehicles with stored credentials — skips e.g. the seeded demo vehicle
  const { rows: vehicles } = await db.query(
    `SELECT v.id, v.tesla_vehicle_id FROM vehicles v
     INNER JOIN vehicle_tokens t ON t.vehicle_id = v.id`
  );
  for (const vehicle of vehicles) {
    try {
      await runStateMachine(db, tesla, vehicle);
    } catch (err) {
      console.error(`[poller] vehicle ${vehicle.id} failed:`, err.message);
    }
  }
}

const LOOP_INTERVAL_MS = 60 * 1000; // base tick, state machine decides actual cadence per vehicle
setInterval(tick, LOOP_INTERVAL_MS);
tick();
