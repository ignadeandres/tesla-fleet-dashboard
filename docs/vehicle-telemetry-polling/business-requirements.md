# Vehicle Telemetry Polling — Business Requirements (Retroactive)

**Status:** Documenting shipped behavior as of commit `22bc01c` ("Add hard daily cap on Tesla Fleet API calls"). No design changes proposed here.

**Source of truth read for this doc:** `worker/src/poller.js`, `worker/src/stateMachine.js`, `worker/src/apiBudget.js`, `worker/src/handlers/{snapshot,trip,charging}.js`, `packages/tesla-client/src/{client,snapshot,units,oauth}.js`, `backend/migrations/006_api_call_budget.sql`.

## Context

The `worker` process polls the Tesla Fleet API on a per-vehicle basis to keep telemetry (location, battery, charging, odometer, drive state) current in Postgres, while staying under Tesla's Fleet API billing/rate quota. The 3 most recent commits fixed a real incident: an earlier unthrottled version of this loop could burn up to 1,440 calls/day/vehicle just on the "is it awake" check, blowing past Tesla's quota — the current adaptive-interval + hard-cap design is the fix.

---

## User Stories

### Story 1 — Adaptive polling cadence per vehicle state
As the system, I want to poll each vehicle at a frequency appropriate to its last-known state, so that active vehicles (driving/charging) get fresh data while idle/asleep vehicles don't waste API quota.

**Acceptance Criteria:**
- Given a vehicle's most recent `telemetry_snapshots.state` is `driving`, the system polls it no more than once per 60 seconds.
- Given the state is `charging`, polling interval is 5 minutes.
- Given the state is `idle`, polling interval is 15 minutes.
- Given the state is `asleep`, polling interval is 10 minutes.
- Given a vehicle has no prior snapshot, it defaults to the `idle` interval.
- Given a vehicle's next poll is not yet due (elapsed time since last poll < interval for its last known state), the system makes **zero** Tesla API calls for that vehicle on that tick — not even the lightweight check (confirmed by `stateMachine.test.js`: "the second tick is within the idle interval — no API call at all, not even the lite one").
- The base worker loop ticks every 60 seconds (`poller.js`); actual per-vehicle poll cadence is enforced inside the state machine, not the outer loop.

### Story 2 — Non-waking presence check before a full poll
As the system, I want to check whether a vehicle is asleep using a lightweight call before doing an expensive full data poll, so that I don't wake a sleeping car (which costs battery and an extra billed call) unnecessarily.

**Acceptance Criteria:**
- When a vehicle's poll is due, the system first calls the lite endpoint (`GET /api/1/vehicles/{id}`, no wake).
- If the lite response reports `state === "asleep"`, the system does **not** proceed to the full `vehicle_data` poll for that tick.
- If the lite response is anything other than `asleep`, the system proceeds to the full poll.

### Story 3 — Asleep state is recorded once, not on every tick
As the system, I want to record an "asleep" transition only the first time it's observed, so that a vehicle sleeping for hours doesn't produce a flood of duplicate null-telemetry rows.

**Acceptance Criteria:**
- Given the vehicle was already known to be `asleep` (last snapshot state), and the lite check again reports asleep, the system inserts **no** new `telemetry_snapshots` row.
- Given the vehicle was in any other known state and the lite check reports asleep, the system inserts exactly one `telemetry_snapshots` row with `state = "asleep"`.

### Story 4 — Hard daily cap on Tesla Fleet API calls
As the operator, I want a hard, DB-persisted ceiling on total billed Tesla API calls per day, so that a bug in the adaptive intervals (or an unexpectedly large fleet) can't run up Tesla's billing/rate quota past what I've budgeted.

**Acceptance Criteria:**
- The system tracks calls consumed in an `api_call_budget(day DATE PRIMARY KEY, calls INTEGER)` table (`backend/migrations/006_api_call_budget.sql`).
- The cap defaults to 300 calls/day and is configurable via `TESLA_MAX_CALLS_PER_DAY`.
- Every billable Tesla API call (both the lite check and the full poll) is gated by a budget check-and-consume that increments `api_call_budget.calls` for the current date.
- Given calls consumed today is below the cap, a check-and-consume call is allowed and the counter is incremented by 1 (`apiBudget.test.js`: "allows and counts a call when under the daily cap").
- Given calls consumed today has reached the cap, a check-and-consume call is denied **and does not increment the counter** (`apiBudget.test.js`: "a blocked call must not itself consume budget").
- Given the budget is exhausted, the state machine skips the remaining work for that vehicle on that tick and logs a warning (distinct log messages for "skipping vehicle" vs "skipping full poll for vehicle").
- The budget counter is persisted in Postgres (not in-memory), so a worker process restart does not reset today's consumed count.

### Story 5 — Odometer, range, and speed are converted to correct units
As the system, I want telemetry values that Tesla returns in miles (odometer, battery range, speed) converted to kilometers before being stored, so that displayed/derived values (distance, efficiency) are correct regardless of what unit the car's own dashboard is set to.

**Acceptance Criteria:**
- `vehicle_state.odometer`, `charge_state.battery_range`, and `drive_state.speed` are always run through `toKm()` (mi → km, factor 1.609344) before being written to `telemetry_snapshots` and `trip_points`.
- The conversion is applied unconditionally — it does **not** branch on `gui_settings.gui_distance_units`, because that field reflects the dashboard display setting only and does not indicate the actual unit of the underlying API values (per code comment: "confirmed against a real vehicle").
- Null/undefined values pass through as null (no conversion attempted on missing data).

### Story 6 — Location data is present on every full poll
As the system, I want the full telemetry poll to include GPS location, so that trip start/end points, trip distance, and charging-session location are actually populated instead of null.

**Acceptance Criteria:**
- The full poll (`getVehicleState`) requests `vehicle_data` with `endpoints=charge_state;climate_state;drive_state;vehicle_state;location_data` explicitly.
- `location_data` is included even though it isn't required to get a 200 response — Tesla omits it by default (privacy gate) unless explicitly requested, which previously caused `drive_state.latitude`/`longitude` to come back empty.

### Story 7 — Trip tracking follows the driving state
As the system, I want a trip record created when a vehicle starts driving and closed when it stops, so that trip history (distance, duration, start/end battery) is captured without manual intervention.

**Acceptance Criteria:**
- A vehicle is considered `driving` if `drive_state.shift_state` is one of `D`/`R`/`N`, or `drive_state.speed > 0`.
- On the first poll where a vehicle is driving and no trip is currently open for it, a `trips` row is inserted with start time, start lat/lng, and start battery level.
- On every subsequent poll while still driving, a `trip_points` row is inserted (timestamp, lat, lng, speed-in-km).
- On the first poll where the vehicle is no longer driving and a trip is open, the trip is closed: `end_time`, `end_lat/lng`, `duration_seconds`, `distance_km` (sum of haversine distances between consecutive `trip_points`), and `end_battery_level` are set.
- Trip state (which trip is "open" per vehicle) is tracked in-memory in the worker process; it is not persisted, so a worker restart mid-trip loses the in-memory link and leaves that trip row incomplete (accepted per code comment as a v1 limitation, not a bug to fix here).

### Story 8 — Charging session tracking follows the charging state
As the system, I want a charging session record created when a vehicle starts charging and closed when it stops, so that charging history and energy-added estimates are captured automatically.

**Acceptance Criteria:**
- A vehicle is considered `charging` if `charge_state.charging_state === "Charging"`.
- On the first poll where charging is detected and no session is open, a `charging_sessions` row is inserted with start time, start battery level, and lat/lng.
- On every poll while charging continues, `end_battery_level` is updated to the current battery level.
- When charging stops and a session is open, it is closed with `end_time`, final `end_battery_level`, and an `energy_added_kwh` estimate computed as `((endLevel - startLevel) / 100) * BATTERY_CAPACITY_KWH` (env-configurable, default 75 kWh).

### Story 9 — A single vehicle's poll failure doesn't stop the rest of the fleet
As the operator, I want one vehicle's polling error to be logged and skipped rather than crashing the worker loop, so that a token issue or API error on one car doesn't stop telemetry collection for the whole fleet.

**Acceptance Criteria:**
- The per-vehicle poll in `poller.js`'s `tick()` is wrapped in try/catch; a thrown error is logged (`[poller] vehicle {id} failed: {message}`) and the loop continues to the next vehicle.

### Story 10 — Only vehicles with stored Tesla credentials are polled
As the system, I want to poll only vehicles that have a valid stored OAuth token, so that vehicles without a completed Tesla account link (e.g., seed/demo data) aren't polled and don't generate errors.

**Acceptance Criteria:**
- The vehicle list for each tick is produced by `SELECT ... FROM vehicles v INNER JOIN vehicle_tokens t ON t.vehicle_id = v.id` — vehicles with no `vehicle_tokens` row are excluded entirely from polling.

---

## Out of Scope (not implemented, do not assume otherwise)

- Real-time push/streaming telemetry (Tesla's separate Fleet Telemetry/websocket product) — this is pure polling only.
- Per-vehicle-configurable polling intervals — the four state intervals are global constants (`INTERVALS_MS`), not per-vehicle or per-user configurable.
- Per-vehicle API budget — the daily cap is a single global counter shared across the whole fleet, not allocated per vehicle.
- Retry/backoff logic on Tesla API errors — a failed call is caught, logged, and simply retried on the next scheduled tick; there is no exponential backoff or circuit breaker.
- Waking a sleeping vehicle — `wakeVehicle()` exists in `packages/tesla-client/src/client.js` but is never called from the polling state machine; the poller only ever passively detects sleep/wake via the lite check.
- Alerting/notification when the daily budget is exhausted — behavior is a `console.warn`; there is no email/webhook/UI alert.
- Any UI/dashboard surface for budget usage (e.g., "X/300 calls used today") — not covered by this feature; this doc is about the worker's polling behavior only.
- Persistence or recovery of `lastPollAt` / open-trip / open-charging-session in-memory state across a worker restart — all three are in-memory `Map`s that reset on restart.
- Multi-instance/horizontal scaling of the worker (e.g., distributed locking) — the design assumes a single worker process.
- Dynamic/automatic tuning of `TESLA_MAX_CALLS_PER_DAY` against Tesla's actual account quota — it's a static env var the operator sets manually.
- Per-vehicle-model battery capacity for energy-added calculation — `BATTERY_CAPACITY_KWH` is one global env var (default 75 kWh), not derived per vehicle/trim.

---

## Assumptions / Open Questions

- **Assumption:** The default `TESLA_MAX_CALLS_PER_DAY=300` is a reasonable starting cap; the code comment says to "tune against the actual free quota shown on the Fleet API Developer Dashboard's Billing and Usage page" — I did not independently verify this against Tesla's current published quota for the account this repo runs against.
- **Assumption:** A shared global daily budget across all vehicles (rather than per-vehicle) is the intended fairness model. Open question: in a multi-vehicle fleet, one vehicle that's frequently driving/charging could consume most of the shared daily budget, starving polling for other vehicles late in the day. Not clear if this is an accepted tradeoff or an unaddressed gap — flagging, not fixing.
- **Open question:** Is losing in-progress trip/charging-session state on worker restart (Story 7/8 limitation) an accepted risk at current scale, or does it need a persisted-state follow-up? The code comments frame it as "acceptable for v1" but there's no tracked follow-up ticket found in this repo.
- **Open question:** `lastPollAt` resetting on worker restart means a restart can trigger an immediate off-schedule poll for every vehicle regardless of interval. Not observed to be guarded against; unclear if this is a known/accepted edge case.
- **Assumption:** The battery-capacity-based energy estimate (Story 8) is a deliberate rough approximation ("adjust as needed" per code comment), not intended to be billing-grade accurate.
