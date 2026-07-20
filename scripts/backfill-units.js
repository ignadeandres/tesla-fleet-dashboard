// One-time fix for telemetry captured before the mi->km normalization landed (see
// packages/tesla-client/src/units.js).
//
// Tesla's raw API payload always reports the car's own display unit (e.g. "mi/hr")
// regardless of whether *our* code has already converted a given row to km — so a row
// already fixed by the new code and a row still needing conversion are indistinguishable
// from their `raw` JSON alone. The only reliable signal is *when* the row was captured,
// relative to when the fix was deployed. You MUST pass that cutoff explicitly:
//
//   BACKFILL_BEFORE="2026-07-20T22:00:00Z" DATABASE_URL=... node scripts/backfill-units.js
//
// Only rows with ts < BACKFILL_BEFORE are converted. Find your cutoff with:
//   docker inspect -f '{{.State.StartedAt}}' $(docker compose ps -q backend)
// (the moment the fixed backend last started) — or just eyeball the last "old-looking"
// row's timestamp in the UI and use that.
//
// IMPORTANT: also stop the worker first (`docker compose stop worker`) so no new row can
// be inserted while this runs, then restart it afterward.
//
// Run this exactly once. Unlike the trip-distance backfill below (safely re-runnable —
// it skips trips that already have a distance), re-running the snapshot backfill with the
// same cutoff WILL convert the same rows a second time and corrupt them again.
import pg from "pg";
import { toKm } from "tesla-client";
import { totalDistanceKm } from "../worker/src/handlers/trip.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfillSnapshots(cutoff) {
  const { rows } = await pool.query(
    `SELECT id, odometer, battery_range, speed, raw FROM telemetry_snapshots
     WHERE raw IS NOT NULL AND ts < $1`,
    [cutoff]
  );
  for (const row of rows) {
    await pool.query(
      `UPDATE telemetry_snapshots SET odometer = $1, battery_range = $2, speed = $3 WHERE id = $4`,
      [toKm(row.odometer, row.raw), toKm(row.battery_range, row.raw), toKm(row.speed, row.raw), row.id]
    );
  }
  console.log(`telemetry_snapshots: converted ${rows.length} row(s) older than ${cutoff}`);
}

// distance_km didn't exist as a computed field before today, so every trip closed
// before now has it NULL — backfill from the (unit-independent) lat/lng breadcrumbs.
async function backfillTripDistances() {
  const { rows: trips } = await pool.query(
    `SELECT id FROM trips WHERE end_time IS NOT NULL AND distance_km IS NULL`
  );
  for (const trip of trips) {
    const { rows: points } = await pool.query(
      `SELECT lat, lng FROM trip_points WHERE trip_id = $1 ORDER BY ts ASC`,
      [trip.id]
    );
    await pool.query(`UPDATE trips SET distance_km = $1 WHERE id = $2`, [totalDistanceKm(points), trip.id]);
  }
  console.log(`trips: computed distance for ${trips.length} trip(s)`);
}

async function main() {
  const cutoff = process.env.BACKFILL_BEFORE;
  if (!cutoff) {
    console.error("Set BACKFILL_BEFORE to an ISO timestamp — see the comment at the top of this file.");
    process.exit(1);
  }
  await backfillSnapshots(cutoff);
  await backfillTripDistances();
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
