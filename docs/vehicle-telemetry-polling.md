# Vehicle Telemetry Polling

How the `worker` process polls the Tesla Fleet API to keep `telemetry_snapshots`, `trips`, `trip_points`, and `charging_sessions` current, and the hard daily cap that protects Tesla's billed/rate quota.

Source of truth: `worker/src/poller.js`, `worker/src/stateMachine.js`, `worker/src/apiBudget.js`, `worker/src/handlers/{snapshot,trip,charging}.js`, `packages/tesla-client/src/{client,snapshot,units}.js`.

## Process shape

`worker/src/poller.js` is a standalone Node process (not part of `backend`, no HTTP server). It runs one loop: every 60 seconds (and once immediately on boot) it queries

```sql
SELECT v.id, v.tesla_vehicle_id FROM vehicles v
INNER JOIN vehicle_tokens t ON t.vehicle_id = v.id
```

— vehicles with no `vehicle_tokens` row (no completed Tesla OAuth link, e.g. seeded demo data) are excluded entirely — and calls `runStateMachine(db, tesla, vehicle)` for each one, sequentially, inside a per-vehicle `try/catch`. One vehicle throwing (bad token, Tesla 5xx, DB error) is logged as `[poller] vehicle {id} failed: {message}` and the loop moves on; it does not abort the rest of the fleet's tick.

The 60s loop is only the *check* frequency. Whether a given vehicle is actually polled on a given tick is decided per-vehicle inside `runStateMachine` (`worker/src/stateMachine.js`).

## Adaptive polling cadence

`runStateMachine` looks up the vehicle's most recent `telemetry_snapshots.state` and passes it to `getPollInterval(db, vehicleId, knownState)` to get a required interval before doing anything else:

| Last known state | Poll interval | Constant |
|---|---|---|
| `driving` | 60 seconds | `INTERVALS_MS.driving` |
| `charging` | 5 minutes | `INTERVALS_MS.charging` |
| `asleep` | 10 minutes | `INTERVALS_MS.asleep` |
| `online`/no snapshot yet, **within 10 minutes of the vehicle's last `driving`/`charging` snapshot** | 90 seconds | `FAST_FOLLOW_INTERVAL_MS` |
| `online`/no snapshot yet, otherwise | 15 minutes | falls back to `INTERVALS_MS.idle` |

These are fixed constants in `stateMachine.js` — not per-vehicle or per-user configurable, and not read from an env var.

### Fast-follow interval (short trips)

The plain 15-minute idle interval let short trips slip through the cracks two ways: a trip entirely shorter than 15 minutes could start and end between two ticks without ever being observed as `driving`, and a longer trip could be caught only once well underway — with `trips.start_time`/`start_lat`/`start_lng` set to wherever the vehicle was at the *first detected* point, not where it actually left from (see `handleTripPoint` in `packages/tesla-client/src/trip.js` — it has no way to backfill a departure point it never observed).

`getPollInterval` shrinks that detection lag for the highest-risk window: whenever the vehicle's most recent `driving`/`charging` snapshot is less than `RECENT_ACTIVITY_WINDOW_MS` (10 minutes) old, it polls at `FAST_FOLLOW_INTERVAL_MS` (90 seconds) instead of the full 15-minute idle interval — covering exactly the "quick stop, then driving again" pattern (errands, drop-off-then-immediately-leaving, etc.). Once the vehicle has been parked longer than that window without driving/charging again, it falls back to the normal 15-minute cadence — a car parked for hours is much less likely to depart in the next instant, and by then it's usually gone properly `asleep` anyway (10-minute cadence, cheap lite-check-only, see below).

This doesn't fully eliminate the gap — the very first trip after a long parked/asleep stretch (not preceded by recent activity) still starts with up to a 15-minute (`online`) or 10-minute (`asleep`) detection lag, and even within the fast-follow window there's still up to ~90 seconds of undetected driving at the start of a trip, during which `trip_points`/distance aren't captured and the recorded `start_lat`/`start_lng` will be slightly past the true departure point. Backfilling the true start location from the last known parked snapshot (a car doesn't move while parked, so that position is known-good even during the undetected gap) would close that residual gap further but isn't implemented — flagged as a follow-up, not attempted here to avoid fabricating trip distance across a gap of unknown-in-between activity.

Elapsed time is tracked in an in-memory `Map<vehicleId, lastPollAt>`, compared against `Date.now()` on every tick:

```js
const last = lastPollAt.get(vehicle.id) || 0;
const interval = INTERVALS_MS[knownState] || INTERVALS_MS.idle;
if (now - last < interval) return; // not due yet
lastPollAt.set(vehicle.id, now);
```

If the vehicle isn't due, `runStateMachine` returns immediately: **zero API calls, zero budget consumption, zero DB writes, no log line.** This is the normal steady-state outcome for most ticks, not an error condition.

`lastPollAt` is set *before* the budget check or any network call, so if the call is later skipped because the daily budget is exhausted (see below), the vehicle's cadence clock still resets — it will not be retried until its full interval elapses again, not on the next 60s tick.

Because `lastPollAt` is an in-memory `Map`, a worker restart resets every vehicle's clock to zero — the first tick after a restart treats every vehicle as immediately due, regardless of when it was truly last polled.

## Lite check before a full poll

A full `vehicle_data` poll wakes a sleeping car, which costs the vehicle's own battery and a billed API call. To avoid that, `runStateMachine` always calls the lightweight, non-waking endpoint first:

1. `tesla.getVehicleLite(vehicleId, teslaVehicleId)` → `GET /api/1/vehicles/{teslaVehicleId}` (never wakes the vehicle).
2. If `lite.response.state === "asleep"`:
   - If the vehicle's previously known state was **not already** `asleep`, insert one `telemetry_snapshots` row with `state: "asleep"`. This records the transition once.
   - If it was **already** `asleep`, write nothing.
   - Either way, stop — the full poll never runs while the vehicle is asleep.
3. Otherwise, proceed to the full poll.

A vehicle already known to be asleep is still checked every 10 minutes (its cadence interval) via the lite call, so a wake-up is detected within one interval — the lite call is never skipped just because the last known state was asleep. This means a car that sleeps for hours produces exactly one `"asleep"` snapshot row, not one per tick.

The full poll requests `vehicle_data` with `endpoints=charge_state;climate_state;drive_state;vehicle_state;location_data`. `location_data` has to be listed explicitly — Tesla omits it by default (privacy gate), which otherwise leaves `drive_state.latitude`/`longitude` empty.

`driving`/`charging` on the full poll are computed as:

```js
const driving = ["D", "R", "N"].includes(data.drive_state?.shift_state) || data.drive_state?.speed > 0;
const charging = data.charge_state?.charging_state === "Charging";
```

Both `trip`/`charging` handlers run unconditionally off these two independent booleans every full poll (open/append or close, whichever applies) — a vehicle that's both `driving` and `charging` in the same poll (e.g. plugged in while reporting nonzero speed) runs both flows in that tick.

`odometer`, `battery_range`, and `speed` are always converted mi→km (`toKm`, factor `1.609344`) before being written, regardless of the vehicle's `gui_settings.gui_distance_units` display setting — per the code comment in `packages/tesla-client/src/units.js`, that field only reflects dashboard display preference, not the actual unit the API returns (verified against a real vehicle). `null`/`undefined` values pass through unconverted.

## Daily API call budget

Independent of the per-vehicle cadence above, every billed call — the lite check *and* the full poll, gated separately — passes through `checkAndConsumeBudget(db)` in `worker/src/apiBudget.js`:

```js
const MAX_CALLS_PER_DAY = Number(process.env.TESLA_MAX_CALLS_PER_DAY || 300);

export async function checkAndConsumeBudget(db) {
  const { rows } = await db.query(`SELECT calls FROM api_call_budget WHERE day = CURRENT_DATE`);
  if ((rows[0]?.calls || 0) >= MAX_CALLS_PER_DAY) return false;
  await db.query(
    `INSERT INTO api_call_budget (day, calls) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET calls = api_call_budget.calls + 1`
  );
  return true;
}
```

The counter lives in Postgres (`api_call_budget(day DATE PRIMARY KEY, calls INTEGER)`, `backend/migrations/006_api_call_budget.sql`), keyed by calendar day — not in memory — so a worker restart mid-day does not reset today's count.

A single tick that reaches the network can consume **up to 2** of the daily budget: one unit for the lite check, one for the full poll. If the budget is denied, the call is not made and the counter is **not** incremented — a denied call is free.

| Gate | Log line on exhaustion | Effect |
|---|---|---|
| Before the lite call | `[stateMachine] daily Tesla API call budget exhausted, skipping vehicle {id}` | No lite call, no full poll, no DB write for this vehicle this tick. |
| Before the full poll (lite already succeeded, vehicle awake) | `[stateMachine] daily Tesla API call budget exhausted, skipping full poll for vehicle {id}` | Lite call's budget unit is already spent; no snapshot/trip/charging updates happen this tick. |

Both are `console.warn` only — no retry, no email/webhook alert, no UI indicator of budget usage.

### Env vars

| Var | Used in | Default | Effect |
|---|---|---|---|
| `TESLA_MAX_CALLS_PER_DAY` | `worker/src/apiBudget.js` | `300` | Hard ceiling on billed Tesla API calls per calendar day, shared across the whole fleet. Read from `process.env` once at module import time. Tune against the actual quota shown on the Fleet API Developer Dashboard's Billing and Usage page — the default isn't derived from any specific account's real quota. |
| `BATTERY_CAPACITY_KWH` | `worker/src/handlers/charging.js` | `75` | Flat battery capacity (kWh) used to estimate `energy_added_kwh` when a charging session closes: `((endLevel - startLevel) / 100) * BATTERY_CAPACITY_KWH`. One global value for the whole fleet — not per vehicle/trim, not read from Tesla's own charge telemetry. |

Both are read via `Number(process.env.X || default)` — an unset var falls back to the default; an unparsable value becomes `NaN` and the corresponding logic silently breaks (no validation on either).

## Known limitations (operator-relevant)

- **All cadence/session tracking is in-memory, not persisted, and is lost on every worker restart:**
  - `lastPollAt` (stateMachine.js) — on restart, every vehicle is treated as immediately due on the first tick, regardless of its actual last-poll time.
  - `openTrips` (`trip.js`) — a restart mid-trip leaves that `trips` row with `end_time` permanently `NULL` and no further `trip_points`; the next driving poll starts a brand-new trip row instead of resuming the old one.
  - `openSessions` (`charging.js`) — same failure mode for `charging_sessions`: a restart mid-charge leaves the row open indefinitely with no `end_time`.
  - This is a deliberate v1 tradeoff (per in-code comments), not an oversight — it bounds the damage to one incomplete row rather than corrupting data, but it means a worker that restarts frequently relative to trip/charging duration will accumulate open rows that never close.

- **The daily budget is one global counter for the whole fleet, not per vehicle.** A vehicle whose cadence makes it due late in the day can be starved entirely if other vehicles already consumed the day's cap before it — this is accepted behavior, not a bug, and there's no fairness/allocation logic across vehicles.

- **`checkAndConsumeBudget` is two sequential queries (`SELECT` then `INSERT ... ON CONFLICT`), not one atomic statement.** Safe today because `poller.js` processes vehicles strictly sequentially in a single process. If the worker is ever scaled to more than one instance, this has a check-then-act race that could let the fleet exceed `TESLA_MAX_CALLS_PER_DAY` by a small margin.

- **No retry/backoff on Tesla API errors.** A failed call is caught by the per-vehicle `try/catch` in `poller.js`, logged, and simply picked up again on that vehicle's next due tick per its normal cadence — no exponential backoff, no circuit breaker.

- **`wakeVehicle()` exists in `packages/tesla-client/src/client.js` but is never called from the polling path.** The poller only ever passively observes sleep/wake via the lite check; it never proactively wakes a car.

- **`energy_added_kwh` is a rough estimate, not Tesla's own energy-added figure**, and uses one global `BATTERY_CAPACITY_KWH` regardless of the actual vehicle's battery size — treat it as directional, not billing-grade.
