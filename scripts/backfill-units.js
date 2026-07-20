// One-time fix for telemetry captured before the mi->km conversion was fixed (see
// packages/tesla-client/src/units.js) — including everything written by the *first*,
// broken version of this fix, which never actually converted anything because it
// incorrectly gated on gui_settings.gui_distance_units (confirmed wrong against a real
// vehicle: that flag does not indicate the unit of odometer/battery_range/speed).
//
//   BACKFILL_BEFORE="2026-07-21T00:00:00Z" DATABASE_URL=... node scripts/backfill-units.js
//
// Only rows with ts < BACKFILL_BEFORE are converted, so anything the *now-fixed* live
// code inserts after you restart the worker doesn't get double-converted. Use "right
// now" as the cutoff — every row currently in the table needs this fix.
//
// IMPORTANT: stop the worker first (`docker compose stop worker`), deploy the units.js
// fix, run this once, then restart the worker. Run this exactly once — re-running with
// the same cutoff WILL convert the same rows again and corrupt them.
import pg from "pg";
import { toKm } from "tesla-client";
import { totalDistanceKm } from "../worker/src/handlers/trip.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function backfillSnapshots(cutoff) {
  const { rows } = await pool.query(
    `SELECT id, odometer, battery_range, speed FROM telemetry_snapshots WHERE ts < $1`,
    [cutoff]
  );
  for (const row of rows) {
    await pool.query(
      `UPDATE telemetry_snapshots SET odometer = $1, battery_range = $2, speed = $3 WHERE id = $4`,
      [toKm(row.odometer), toKm(row.battery_range), toKm(row.speed), row.id]
    );
  }
  console.log(`telemetry_snapshots: converted ${rows.length} row(s) older than ${cutoff}`);
}

async function backfillTripPointSpeeds(cutoff) {
  const { rows } = await pool.query(`SELECT id, speed FROM trip_points WHERE ts < $1`, [cutoff]);
  for (const row of rows) {
    await pool.query(`UPDATE trip_points SET speed = $1 WHERE id = $2`, [toKm(row.speed), row.id]);
  }
  console.log(`trip_points: converted ${rows.length} row(s) older than ${cutoff}`);
}

// distance_km didn't exist as a computed field before today, so every trip closed
// before now has it NULL — backfill from the (unit-independent) lat/lng breadcrumbs.
// Safe to re-run: skips trips that already have a distance.
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
  await backfillTripPointSpeeds(cutoff);
  await backfillTripDistances();
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
