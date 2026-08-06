# Tech Spec — Vehicle Telemetry Polling

**Feature:** Worker adaptive polling state machine + hard daily Tesla API call budget
**Status:** Already implemented and shipped. Grounded in `docs/vehicle-telemetry-polling/functional-spec.md`.

## Architecture

### Process topology

```
                     ┌─────────────────────┐
   HTTP/GraphQL      │      backend         │
   (browser) ───────▶│  Apollo Server +     │───┐
                      │  Express             │   │
                      └─────────────────────┘   │
                                                  │  both depend on
┌──────────────────────────────┐                 │  packages/tesla-client
│           worker              │                 │
│  (long-running Node process,  │◀────────────────┘
│   no HTTP server, no request  │
│   handler — just a timer loop)│
└──────────────────────────────┘
        │                    │
        │ pg.Pool            │ tesla-client.call()
        ▼                    ▼
   PostgreSQL          Tesla Fleet API
 (single shared DB,
  same instance the
  backend reads from)
```

`backend` and `worker` are two separate npm-workspace packages (`worker/package.json`, `backend/package.json`) that each declare their own dependency on the shared `tesla-client` workspace package (`"tesla-client": "1.0.0"`) and their own `pg` client. They are independently started (`node src/index.js` vs `node src/poller.js`) and share nothing at runtime except the Postgres database and the `tesla-client` code they each import a copy of into their own process.

### Worker internal structure

`worker/src/poller.js` is the process entrypoint. It owns exactly three things: a `pg.Pool`, a `tesla-client` instance built via `createTeslaClient(db, teslaConfig)`, and a `setInterval(tick, 60_000)` that also fires once immediately on boot. `tick()` does one thing: it queries `vehicles INNER JOIN vehicle_tokens` to get the list of vehicles that have a stored OAuth token, then loops over them sequentially (not `Promise.all`), calling `runStateMachine(db, tesla, vehicle)` for each one inside a per-vehicle `try/catch` so one vehicle's thrown error (bad token, Tesla API 5xx, DB error) is logged and skipped without aborting the rest of the fleet's tick.

`worker/src/stateMachine.js` (`runStateMachine`) is where all the actual per-vehicle decision logic lives — the 60-second outer loop in `poller.js` is just a scheduler; the state machine decides, per vehicle per tick, whether anything happens at all:

1. Read the vehicle's most recent `telemetry_snapshots.state` (defaults to `"idle"` if no row exists yet) and use it as a key into a fixed `INTERVALS_MS` table (`driving: 60s`, `charging: 5m`, `idle: 15m`, `asleep: 10m`).
2. Compare against an in-memory `Map<vehicleId, lastPollAt>` — if not due, return immediately with zero API calls, zero budget consumption, zero DB writes.
3. If due, mark `lastPollAt` now (before any call), then gate on `checkAndConsumeBudget(db)`.
4. Call `tesla.getVehicleLite()` (non-waking). If asleep, conditionally write a single `"asleep"` snapshot row (only on the transition, not every tick) and stop.
5. Gate the budget a second time, then call `tesla.getVehicleState()` (the full, waking poll), derive `driving`/`charging`/`online` from `drive_state`/`charge_state`, write one `telemetry_snapshots` row, and dispatch to the trip and charging handlers based on those booleans.

`worker/src/handlers/{snapshot,trip,charging}.js` are the per-concern write modules the state machine calls into. `snapshot.js` is a thin re-export of `saveSnapshot` from `tesla-client` (the unit-conversion and row-shaping logic lives in the shared package, not duplicated in the worker). `trip.js` and `charging.js` each own an in-memory `Map<vehicleId, openTrip|openSession>` plus the SQL to open, update, and close the corresponding `trips`/`charging_sessions` rows, and are invoked unconditionally on every full poll (once for the driving branch, once for the charging branch — the two are independent, not mutually exclusive).

`worker/src/apiBudget.js` is a single exported function, `checkAndConsumeBudget(db)`, called from two places in `stateMachine.js` (once for the lite call, once for the full poll) — it is the single choke point every billed Tesla API call passes through, keyed on the `api_call_budget(day, calls)` Postgres table.

### Integration with `packages/tesla-client`

The worker never talks to Tesla's HTTP API directly — it goes through `createTeslaClient(db, teslaConfig)`, which returns an object exposing `getVehicleState` (full poll, explicit `endpoints=charge_state;climate_state;drive_state;vehicle_state;location_data` — `location_data` is opt-in on Tesla's side and must be requested explicitly or lat/lng come back empty), `getVehicleLite` (bare `GET /vehicles/{id}`, non-waking), and `wakeVehicle` (present in the client but never invoked from the polling path). Every call routes through the client's internal `call()`, which calls `ensureFreshToken(db, vehicleId, teslaConfig)` from `tesla-client/src/oauth.js` before each request — token refresh is handled inside the shared client using the same `db` pool the worker passed in, not duplicated in worker code. `backend` imports the same `tesla-client` package (for the OAuth callback / initial vehicle listing via `fetchTeslaVehicles`), so the Tesla API integration surface — auth, endpoint shapes, unit conversion (`toKm`), snapshot persistence shape — is defined exactly once and consumed by both processes.

### Integration with Postgres

Both `backend` and `worker` connect to the same Postgres database with their own independent `pg.Pool`; there is no API boundary between them for data — `worker` writes `telemetry_snapshots`, `trips`, `trip_points`, `charging_sessions`, and `api_call_budget` rows directly via SQL, and `backend`'s GraphQL resolvers read those same tables directly. The database is the integration point between the two processes, not a queue or an internal API.

### ADR: Polling logic lives in `worker`, not inside the `backend` GraphQL server

**Decision:** the adaptive polling loop runs in a separate, independently-started Node process (`worker`) rather than as a background task inside the `backend` Apollo/Express server.
**Alternative considered:** a `setInterval` started inside `backend`'s process alongside the GraphQL server.
**Why the existing split makes sense:** `backend` is a request/response server whose process lifecycle is driven by HTTP traffic (deploys, restarts, scaling are tied to serving GraphQL requests); `worker` is a long-lived timer loop whose lifecycle is driven by "is it time to poll a vehicle," which is unrelated to whether anyone is hitting the API right now. Running the poller inside `backend` would mean every deploy/restart of the API server also interrupts telemetry collection (and vice versa — a stuck Tesla API call in the poller would risk starving the event loop the GraphQL server also needs). Keeping them as separate `npm workspaces` packages that both depend on `tesla-client` gets the code reuse (auth, endpoint shapes, unit conversion) without coupling their runtime lifecycles or deployment cadence.

### ADR: Daily API budget counter is persisted in Postgres, not kept in-memory

**Decision:** `api_call_budget` is a DB table (`day DATE PRIMARY KEY, calls INTEGER`), checked and incremented via `checkAndConsumeBudget(db)` on every billable call.
**Alternative considered:** an in-memory counter (`let callsToday = 0`) reset on process start.
**Why the existing choice makes sense:** the whole point of this feature (per the commit history — `22bc01c`, fixing a real incident where an earlier unthrottled version burned up to 1,440 calls/day/vehicle) is a *hard, restart-proof* ceiling against Tesla's billing quota. An in-memory counter resets to zero on every worker crash/redeploy, which defeats a "hard daily cap" the moment the process happens to restart more than once in a day — exactly the failure mode this feature exists to close. The state machine's per-vehicle intervals (`INTERVALS_MS`) already do the everyday-case throttling in-memory; the DB-persisted budget is deliberately the independent backstop for the case those intervals aren't enough, so it has to survive the same restarts that would otherwise silently reset it.

### ADR: Cadence is derived from last-known vehicle state, not a fixed poll interval

**Decision:** the next poll time for a vehicle is computed from its most recently recorded `telemetry_snapshots.state` (`driving`/`charging`/`idle`/`asleep` each map to a different interval), not a single fixed interval for all vehicles.
**Alternative considered:** one fixed interval for every vehicle regardless of state (which is effectively what the pre-incident version did for the "asleep" check, and is what caused the billing overrun).
**Why the existing choice makes sense:** this replaced a real incident where polling an idle/asleep vehicle at the same rate as a driving one wasted the large majority of the daily budget on vehicles that had nothing new to report, while a fixed *slow* interval for everyone would make a moving vehicle's location stale. Deriving cadence from last-known state gets both properties — a driving vehicle is checked every 60s, an idle one every 15 minutes — using data the worker already has (the last snapshot row) rather than adding new infrastructure (no scheduler, no per-vehicle config, no external service) to get adaptive behavior.

### ADR: Trip and charging-session "open" tracking is in-memory, not DB-persisted

**Decision:** `openTrips`/`openSessions` in `worker/src/handlers/{trip,charging}.js` are plain in-process `Map`s keyed by vehicle ID; there is no `is_open` column or similar durable pointer in `trips`/`charging_sessions` that the worker re-derives on startup.
**Alternative considered:** persist the "which trip/session is currently open for this vehicle" pointer in Postgres (e.g., a nullable FK on `vehicles`, or a status column queried on worker boot) so a restart could resume mid-trip.
**Why the existing choice makes sense given what's shipped:** the failure mode is bounded and self-correcting rather than corrupting — a worker restart mid-trip leaves one `trips` row without an `end_time` and simply starts a fresh trip row on the next driving poll; it does not lose telemetry, duplicate data, or require reconciliation logic. Building restart-safe resumption (re-querying for the latest still-open trip/session per vehicle, handling the ambiguity of "is this genuinely still open or was it actually closed while the worker was down") is real complexity that only pays for itself if worker restarts are frequent relative to trip/charging-session duration; the code comments in both handlers explicitly frame this as an accepted v1 tradeoff, not an oversight, on the basis that worker restarts are infrequent. This is the same category of tradeoff as the budget counter above but resolved the other way — the budget counter protects an external, billed, hard-capped resource (Tesla's API quota) where a reset is a compliance/cost problem, while an incomplete trip row is an internal data-completeness gap with no cost consequence, so it doesn't warrant the same persistence investment.

### Security / data-boundary notes for handoff

- The worker process holds direct Postgres write access to the same tables `backend` serves over GraphQL (no API boundary between them) — anyone who can reach the worker's DB credentials can write telemetry, trip, or budget data directly, bypassing any authorization the GraphQL layer enforces on reads.
- OAuth token refresh (`ensureFreshToken`) is invoked from within the worker process using tokens read from `vehicle_tokens` — the worker has standing access to decrypt/use every linked vehicle's Tesla credentials on every tick, for as long as it runs.
- The `api_call_budget` table has no access control beyond normal DB permissions; anything with write access to that table can reset or falsify the day's counter, silently defeating the billing cap.

## Data & API Design

### 1. Domain model

Entities added by this feature, relative to the pre-existing `vehicles` table (`backend/migrations/001_init.sql`):

- **Vehicle** (existing) `1 --- *` **TelemetrySnapshot** — one append-only row per poll tick (or per sleep transition). No update/delete path; history table.
- **Vehicle** `1 --- *` **Trip** `1 --- *` **TripPoint** — a Trip is a driving episode; TripPoints are the GPS breadcrumbs recorded while it's open. Cardinality "1 open Trip per vehicle at a time" is enforced only in-memory (`worker/src/handlers/trip.js`'s `openTrips: Map<vehicleId, {id, startTime}>`), not by a DB constraint — no partial unique index prevents two open trips for the same vehicle at the schema level.
- **Vehicle** `1 --- *` **ChargingSession** — same shape as Trip but without child points; running `end_battery_level` is updated in place on every poll while charging continues, not appended. "1 open session per vehicle" is likewise only enforced by `worker/src/handlers/charging.js`'s `openSessions: Map<vehicleId, {id}>`.
- **ApiCallBudget** — a global, day-keyed counter, not related to Vehicle at all (no `vehicle_id`). One row per calendar day, incremented once per billed Tesla API call across the whole fleet.

Neither Trip nor ChargingSession has an explicit "is open" boolean column — openness is derived as `end_time IS NULL`, and that state only exists durably in the DB after the row is inserted; between worker restarts, an in-progress trip/session that hasn't been closed is orphaned with `end_time` permanently NULL (acceptable per the code comment in `trip.js`).

### 2. Database schema

**`telemetry_snapshots`** — `backend/migrations/002_telemetry.sql`
```sql
CREATE TABLE telemetry_snapshots (
  id BIGSERIAL PRIMARY KEY,
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  state TEXT,
  battery_level SMALLINT,
  battery_range NUMERIC,
  speed NUMERIC,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  heading SMALLINT,
  odometer NUMERIC,
  software_version TEXT,
  locked BOOLEAN,
  climate_on BOOLEAN,
  inside_temp NUMERIC,
  outside_temp NUMERIC,
  door_state JSONB,
  window_state JSONB,
  tire_pressure JSONB,
  raw JSONB
);
CREATE INDEX idx_telemetry_vehicle_ts ON telemetry_snapshots (vehicle_id, ts DESC);
```
`vehicle_id` is nullable (FK has no `NOT NULL`); no uniqueness constraint on `(vehicle_id, ts)`, so duplicate-timestamp rows are possible if ever inserted twice. All numeric distance/speed columns are stored in km / km/h (converted from Tesla's mi / mph at write time — see `toKm` below). `raw` holds the full `vehicle_data` response JSON (or `{}` when the row is just an asleep-transition marker).

**`trips`** — `backend/migrations/003_trips.sql`, extended by `005_trip_battery.sql`
```sql
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
  duration_seconds INTEGER,
  start_battery_level SMALLINT,  -- added in 005_trip_battery.sql
  end_battery_level SMALLINT     -- added in 005_trip_battery.sql
);
```
`end_time`, `end_lat/lng`, `distance_km`, `duration_seconds`, `end_battery_level` are all NULL until `closeTripIfOpen` runs. `distance_km` is computed once at close time from `trip_points`, not maintained incrementally.

**`trip_points`** — `backend/migrations/003_trips.sql`
```sql
CREATE TABLE trip_points (
  id BIGSERIAL PRIMARY KEY,
  trip_id UUID REFERENCES trips(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  speed NUMERIC
);
CREATE INDEX idx_trip_points_trip ON trip_points (trip_id, ts);
```
`trip_id` nullable at schema level (no `NOT NULL`) though always populated in practice; one row inserted per driving poll tick.

**`charging_sessions`** — `backend/migrations/004_charging.sql`
```sql
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
```
No index beyond the PK/FK. `lat`/`lng` are the *start* location only (no end location column). `energy_added_kwh` is NULL until close; computed as `((end_battery_level - start_battery_level) / 100) * BATTERY_CAPACITY_KWH` (env `BATTERY_CAPACITY_KWH`, default 75) — a flat estimate, not drawn from Tesla's own energy-added field.

**`api_call_budget`** — `backend/migrations/006_api_call_budget.sql`
```sql
CREATE TABLE api_call_budget (
  day DATE PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
```
No FK to `vehicles` — global fleet-wide counter, one row per calendar day, upserted via `ON CONFLICT (day) DO UPDATE`.

### 3. Internal module API

**`checkAndConsumeBudget(db): Promise<boolean>`** — `worker/src/apiBudget.js`
Reads `api_call_budget.calls` for `CURRENT_DATE`; if `>= MAX_CALLS_PER_DAY` (env `TESLA_MAX_CALLS_PER_DAY`, default 300) returns `false` without writing. Otherwise upserts the row (`INSERT ... ON CONFLICT (day) DO UPDATE SET calls = calls + 1`) and returns `true`. Called twice per state-machine tick that reaches the network — once before the lite check, once before the full poll — so a single tick can consume up to 2 of the daily budget.

**`saveSnapshot(db, vehicleId, { state, ts, raw }): Promise<void>`** — re-exported from `packages/tesla-client/src/snapshot.js` via `worker/src/handlers/snapshot.js`. `raw` is optional (defaults to `{}`, e.g. for the asleep-transition-only call); pulls `vehicle_state`, `charge_state`, `drive_state`, `climate_state` off it, converts `odometer`/`battery_range`/`speed` mi→km via `toKm`, and inserts one `telemetry_snapshots` row. Shared by both the worker poller and the backend's manual-refresh mutation.

**`handleTripPoint(db, vehicleId, data): Promise<void>`** — `worker/src/handlers/trip.js`. `data` is the raw `vehicle_data.response` object. If `openTrips` has no entry for `vehicleId`, inserts a new `trips` row (`start_time`/`start_lat`/`start_lng` from now/`drive_state`, `start_battery_level` from `charge_state.battery_level`) and caches `{id, startTime}` in the map; always inserts one `trip_points` row (lat/lng from `drive_state`, `speed` converted via `toKm(drive_state.speed)`).

**`closeTripIfOpen(db, vehicleId, data): Promise<void>`** — same file. No-op if no open trip cached. Otherwise reads all `trip_points` for the trip ordered by `ts`, sums haversine distance between consecutive points (`totalDistanceKm`, `EARTH_RADIUS_KM = 6371`), and `UPDATE`s `end_time`, `end_lat/lng` (from current `drive_state`), `duration_seconds`, `distance_km`, `end_battery_level` (from current `charge_state.battery_level`); removes the vehicle from `openTrips`.

**`handleChargingUpdate(db, vehicleId, data): Promise<void>`** — `worker/src/handlers/charging.js`. If no cached open session, inserts a `charging_sessions` row (`start_battery_level` from `charge_state.battery_level`, `lat`/`lng` from `drive_state`) and caches `{id}`. Every call (open or not) then `UPDATE`s `end_battery_level` on that row — i.e. it's overwritten on every charging poll tick, not appended.

**`closeChargingSessionIfOpen(db, vehicleId, data): Promise<void>`** — same file. No-op if no open session cached. Re-reads `start_battery_level` from the DB, computes `energy_added_kwh` from the flat capacity estimate described above, `UPDATE`s `end_time`/`end_battery_level`/`energy_added_kwh`, removes the vehicle from `openSessions`.

**Tesla client response shapes consumed** (`packages/tesla-client/src/client.js`):
- `getVehicleLite(vehicleId, teslaVehicleId)` → `GET /api/1/vehicles/{teslaVehicleId}`, response used only via `lite.response.state` (checked for `"asleep"`).
- `getVehicleState(vehicleId, teslaVehicleId)` → `GET /api/1/vehicles/{teslaVehicleId}/vehicle_data?endpoints=charge_state;climate_state;drive_state;vehicle_state;location_data` (explicit `location_data` needed or `drive_state.latitude/longitude` come back empty). `full.response` is the `data` object consumed throughout: `data.drive_state.{shift_state,speed,latitude,longitude,heading}`, `data.charge_state.{charging_state,battery_level,battery_range}`, `data.vehicle_state.{odometer,car_version,locked,df,dr,pf,pr,fd_window,fp_window,rd_window,rp_window,tpms_pressure}`, `data.climate_state.{is_climate_on,inside_temp,outside_temp}`.

**State classification in `runStateMachine`** (`worker/src/stateMachine.js`): `driving = ["D","R","N"].includes(drive_state.shift_state) || drive_state.speed > 0`; `charging = charge_state.charging_state === "Charging"`; resulting `state` written to `telemetry_snapshots.state` is `"driving" | "charging" | "online"` (plus the separate `"asleep"` short-circuit before any full poll). `handleTripPoint`/`closeTripIfOpen` and `handleChargingUpdate`/`closeChargingSessionIfOpen` are each called unconditionally every tick (the "close" variant is the no-op branch when the corresponding boolean is false), so both trip and charging state machines run independently off the same poll.

**Files consulted** (read-only, not modified): `worker/src/poller.js`, `worker/src/stateMachine.js`, `worker/src/apiBudget.js`, `worker/src/handlers/{snapshot,trip,charging}.js`, `packages/tesla-client/src/{client,snapshot,units}.js`, `backend/migrations/{001_init,002_telemetry,003_trips,004_charging,005_trip_battery,006_api_call_budget}.sql`.
