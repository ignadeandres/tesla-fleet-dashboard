# Functional Spec — Vehicle Telemetry Polling

**Feature:** Worker adaptive polling state machine + hard daily Tesla API call budget
**Status:** Already implemented and shipped. Elaborates `docs/vehicle-telemetry-polling/business-requirements.md`. Backend-only feature — no user-facing UI, so no User Flow section.

## Functional Behavior

### 1. Base Poll Loop

- The worker process runs one continuous loop, ticking every 60 seconds (fires immediately on worker start, then every 60s thereafter).
- Each tick builds the list of eligible vehicles (see §9) and processes them one at a time, in sequence, not in parallel.
- The 60s tick is only the *check* frequency — it does not mean every vehicle is polled every 60s. Whether a given vehicle is actually polled on a given tick is decided per-vehicle by the cadence gate in §2.

### 2. Per-Vehicle Cadence Gate (Adaptive Polling)

**Flow, per vehicle, per tick:**
1. Look up the vehicle's most recently recorded state by querying the latest `telemetry_snapshots` row (most recent `ts`).
2. **Empty state:** if no snapshot row exists yet for this vehicle (never polled successfully before), treat known state as `idle` for cadence purposes only.
3. Resolve the required polling interval for that known state:
   - `driving` → 60 seconds
   - `charging` → 5 minutes
   - `idle` → 15 minutes
   - `asleep` → 10 minutes
   - Any other recorded state (in practice: `online`, meaning "awake, not driving, not charging") → falls back to the `idle` interval (15 min). This is a direct consequence of the cadence table only covering the four states above; `online` is not itself a cadence tier.
4. Compare time elapsed since this vehicle was last *attempted* (in-memory, per worker-process-lifetime tracking) against the resolved interval.
5. **Not due (elapsed < interval):** skip this vehicle entirely for this tick. **Zero API calls are made** — not even the lite presence check. No budget is consumed, no DB write occurs, no log entry is produced (this is the normal, expected steady-state outcome, not an error/warning condition).
6. **Due (elapsed ≥ interval):** the vehicle's "last attempted" marker is updated to now *before* any API call is made or budget is checked, and processing proceeds to §3. This means that even if the attempt is later skipped because the budget is exhausted, the vehicle's cadence clock still resets from this tick — it will not be retried until its full interval elapses again, not on the next 60s tick.

**Business rules:**
- Cadence is derived purely from the last *known* state persisted for the vehicle; it is not configurable per vehicle and not user-adjustable.
- In-memory "last attempted" bookkeeping does not survive a worker restart. On restart, every vehicle's clock resets to zero, so the first tick after a restart treats every vehicle as immediately due, regardless of when it was truly last polled.

### 3. Presence Check (Lite Poll) Before Waking the Vehicle

Runs only when §2 determines the vehicle is due.

**Flow:**
1. Consume one unit from the daily API budget (§7) for the upcoming lite call. If the budget is exhausted, stop processing this vehicle for this tick (see §7 for the exact skip behavior/logging).
2. Call the non-waking lite endpoint (`GET /api/1/vehicles/{id}`) — this call never wakes a sleeping vehicle.
3. **If the lite response reports the vehicle as asleep:**
   - If the vehicle's previously known state was *not* already `asleep`: insert exactly one new `telemetry_snapshots` row with `state = "asleep"` and the current timestamp. This is the only DB write for this tick.
   - If the vehicle's previously known state *was already* `asleep`: write nothing. No new snapshot row is created.
   - In both cases, stop processing this vehicle for this tick — the full poll (§4) is never attempted while the vehicle is asleep.
4. **If the lite response reports anything other than asleep:** proceed to the full poll (§4).

**Business rules:**
- Asleep is recorded as a state *transition*, not a recurring status. A vehicle that stays asleep for its entire 10-minute-interval cadence produces one snapshot row at the moment it's first observed asleep, not one row per tick.
- A vehicle already known asleep is still checked every 10 minutes (per §2) via the lite call, so a wake-up is detected within one cadence interval — the lite call itself is never skipped just because the vehicle was last known asleep.

### 4. Full Poll — Data Collected and Unit Conversion

Runs only when the lite check (§3) reports the vehicle as not asleep.

**Flow:**
1. Consume a second unit from the daily API budget for the full poll. If exhausted, stop processing this vehicle for this tick (see §7). Note: at this point the lite call's budget unit has already been spent even though the full poll itself is skipped.
2. Call `vehicle_data` explicitly requesting `charge_state`, `climate_state`, `drive_state`, `vehicle_state`, and `location_data`. `location_data` must be requested explicitly — Tesla omits it by default, and without it `drive_state.latitude`/`longitude` come back empty.
3. Determine `driving`: true if `drive_state.shift_state` is one of `D`, `R`, `N`, **or** `drive_state.speed > 0`.
4. Determine `charging`: true if `charge_state.charging_state === "Charging"`.
5. Compute the snapshot's recorded state label: `driving` takes priority, else `charging`, else `online`. (Note: this label is for the snapshot row only — the independent trip-tracking and charging-tracking flows in §5/§6 each run off their own `driving`/`charging` booleans, not off this combined label. If a vehicle simultaneously satisfies both `driving` and `charging` conditions — an edge case, e.g. a plugged-in vehicle reporting nonzero speed — both the trip-point flow and the charging-update flow execute in the same poll.)
6. Insert one `telemetry_snapshots` row: current timestamp, computed state label, and the full raw response payload, including battery level, battery range, speed, lat/lng, heading, odometer, software version, lock state, climate state/temps, door/window state, tire pressures.
7. Then run trip tracking (§5) and charging-session tracking (§6), each independently, based on the `driving`/`charging` booleans from steps 3–4.

**Unit conversion business rule (applies to every full poll, unconditionally):**
- `odometer`, `battery_range`, and `speed` are always converted from miles/mph to km (multiply by 1.609344) before being stored, in the snapshot row and in trip-point speed.
- This conversion never branches on `gui_settings.gui_distance_units` — that field reflects the driver's dashboard display preference, not the actual unit Tesla's API returns these fields in, and has been confirmed against a real vehicle to always be miles/mph regardless of that setting.
- If the source value is null or undefined, it passes through unchanged (stored as null) — no conversion is attempted on missing data.

### 5. Trip Tracking

Runs on every full poll (§4), independently based on the `driving` boolean.

**While driving:**
1. Check for an in-memory open trip for this vehicle.
2. **No open trip (first driving poll after not driving):** insert a new `trips` row — start time (now), start lat/lng (from `drive_state`), start battery level (from `charge_state.battery_level`, null if unavailable). This becomes the open trip for the vehicle in memory.
3. **Every driving poll, including the one that just opened the trip:** insert a `trip_points` row — timestamp, lat, lng, and speed converted to km.

**No longer driving:**
- **Open trip exists:** close it — compute `duration_seconds` (now minus trip start time), compute `distance_km` as the sum of haversine distances between consecutive `trip_points` (ordered by timestamp) recorded for that trip, and update the `trips` row with end time, end lat/lng (current poll's `drive_state` position), duration, distance, and end battery level. The trip is then removed from the in-memory open-trip tracking.
- **No open trip:** no action (e.g., vehicle has been non-driving all along, or the trip was already closed).

**Business rules / known limitations:**
- Which trip a set of `trip_points` belongs to is tracked entirely in the worker process's memory, not persisted. A worker restart while a trip is in progress permanently loses the link between that vehicle and its open trip — the in-progress `trips` row is left without an `end_time` and no further points are appended to it (any subsequent driving detected after restart starts a brand-new trip). This is an accepted v1 limitation, not a bug to fix.
- Distance is only ever computed from recorded `trip_points`, so a trip with a single point (e.g., driving detected once then immediately stopped) closes with `distance_km = 0`.

### 6. Charging Session Tracking

Runs on every full poll (§4), independently based on the `charging` boolean.

**While charging:**
1. Check for an in-memory open charging session for this vehicle.
2. **No open session (first charging poll after not charging):** insert a new `charging_sessions` row — start time (now), start battery level, start lat/lng (from `drive_state` at that moment).
3. **Every charging poll, including the one that just opened the session:** update `end_battery_level` on that session's row to the current battery level. This means a session that opens and closes within the same interval still has a meaningful `end_battery_level` reflecting the latest known reading.

**No longer charging:**
- **Open session exists:** close it — read the session's `start_battery_level` back from the database (not from memory), take the current battery level as `endLevel` (falling back to `startLevel` if unavailable), compute `energy_added_kwh = ((endLevel - startLevel) / 100) * BATTERY_CAPACITY_KWH` (env-configurable, default 75 kWh), and update the row with end time, final end battery level, and the computed energy figure. The session is then removed from in-memory tracking.
- **No open session:** no action.

**Business rules / known limitations:**
- `energy_added_kwh` is a deliberate rough approximation based on a single fixed battery capacity constant for the whole fleet — it does not account for per-vehicle-model battery capacity differences.
- Same in-memory-only limitation as trips (§5): a worker restart mid-charging-session loses the link to that session; the DB row is left open indefinitely with no `end_time`.

### 7. Daily API Call Budget Enforcement

Applies globally across the whole fleet (one shared counter, not per-vehicle), gating both the lite call (§3) and the full poll call (§4) as two separate, individually-gated consumptions.

**Flow, each time a billable call is about to be made:**
1. Read today's call count (keyed by calendar date; a new day starts implicitly at 0 since no row exists yet for that date).
2. **Under the cap (default 300/day, configurable via `TESLA_MAX_CALLS_PER_DAY`):** allow the call, increment today's counter by 1, proceed.
3. **At or over the cap:** deny the call, counter is **not** incremented, and the caller aborts that vehicle's remaining work for this tick.

**System states / skip messaging (two distinct points, logged separately so it's diagnosable which call was blocked):**
- Denied at the **lite-call gate**: log `"[stateMachine] daily Tesla API call budget exhausted, skipping vehicle {id}"` — no lite call, no full poll, no DB write for this vehicle this tick.
- Denied at the **full-poll gate** (lite call already succeeded and reported the vehicle awake): log `"[stateMachine] daily Tesla API call budget exhausted, skipping full poll for vehicle {id}"` — the lite call's budget unit was already spent this tick, but no full poll happens, so no snapshot/trip/charging updates occur for this vehicle this tick.
- No other alerting occurs on budget exhaustion — these are `console.warn` log lines only, with no notification, retry, or escalation.

**Business rules:**
- The counter is persisted in Postgres (`api_call_budget`, keyed by day), so a worker restart mid-day does not reset it — accumulated usage for the day is preserved.
- Because the budget is shared across the entire fleet rather than allocated per vehicle, a vehicle whose cadence makes it due late in the day can be starved entirely if other vehicles have already consumed the day's cap — this is a known, unresolved tradeoff, not a bug.
- Exhaustion does not stop the tick loop or other vehicles queued later in the same tick from being *attempted* — each vehicle independently re-checks the budget and will be skipped individually once the cap is hit.

### 8. Single-Vehicle Failure Isolation

**Flow:**
- Each vehicle's entire poll attempt (cadence check through snapshot/trip/charging updates) is wrapped in a per-vehicle try/catch at the top of the tick loop.
- **Error state:** if any step throws (e.g., the Tesla API responds with a non-2xx status, a network failure, a DB write failure), the error is caught, logged as `"[poller] vehicle {id} failed: {message}"`, and the loop immediately proceeds to the next vehicle in this tick.
- No retry is attempted within the same tick or via backoff — the vehicle simply gets picked up again on its next due tick per its normal cadence (§2).

**Business rule:** one vehicle's failure (bad token, Tesla API outage for that car, malformed response, etc.) never blocks or delays polling of any other vehicle in the same tick.

### 9. Vehicle Eligibility

**Flow:**
- At the start of every tick, the worker selects vehicles via an inner join between `vehicles` and `vehicle_tokens` on vehicle ID.
- **Empty/excluded state:** a vehicle with no corresponding `vehicle_tokens` row (i.e., no stored Tesla credentials — e.g. a seeded demo vehicle) is excluded from the query result entirely. It is never attempted, never logged as skipped, and produces no snapshots, trips, or charging sessions via this polling path for as long as it lacks stored credentials.

**Business rule:** credential presence is a hard eligibility gate evaluated fresh every tick — a vehicle that gains credentials (completes auth) becomes eligible starting from the next tick without any other action.

**Files consulted** (read-only, not modified): `worker/src/poller.js`, `worker/src/stateMachine.js`, `worker/src/apiBudget.js`, `worker/src/handlers/{snapshot,trip,charging}.js`, `packages/tesla-client/src/{client,snapshot,units,oauth}.js`.
