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
  const { rows: vehicles } = await db.query(`SELECT id, tesla_vehicle_id FROM vehicles`);
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
