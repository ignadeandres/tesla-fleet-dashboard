# Tech Spec — Battery Health Trends

**Feature:** User-facing "Trends" chart — raw battery level over time, read-only
**Status:** Already implemented and shipped. Grounded in `docs/battery-health-trends/functional-spec.md`. The `telemetry_snapshots` table schema is documented separately at `docs/vehicle-telemetry-polling/tech-spec.md` — not repeated here.

## Architecture

Component chain: `TrendsPage.jsx` → `VEHICLE_STATE_LOG_QUERY` (GraphQL) → `Vehicle.stateLog` resolver (`backend/src/graphql/resolvers/types.js`) → `getStateLog` (`backend/src/db/queries/telemetry.js`) → `telemetry_snapshots` table (schema in `docs/vehicle-telemetry-polling/tech-spec.md`).

The page is a thin client over an existing, shared endpoint — no new backend code was written for this feature. `Vehicle.stateLog(from, to)` is the same resolver/query the "vehicle-state-log" feature uses; it returns the full snapshot row (state, battery, odometer, doors, climate, etc., capped at `MAX_STATE_LOG_ROWS`). Battery-health-trends is purely a different frontend projection of that same data: `VEHICLE_STATE_LOG_QUERY` requests every field (unchanged, shared query shape) but `BatteryTrendChart` only reads `ts` and `batteryLevel`, discarding the rest. Any change to `getStateLog` or its resolver affects both features.

One client-side detail worth noting: `getStateLog` returns rows `ORDER BY ts DESC` (newest first, matching how vehicle-state-log wants to display them). `TrendsPage` reverses the array (`[...log].reverse()`) before handing it to the chart so Recharts plots left-to-right chronologically. This reversal is local to `TrendsPage` — it doesn't affect the shared query or resolver.

Nothing else here is architecturally non-trivial: no caching, no new service, no pagination logic beyond the existing row cap — it's a query, a resolver reuse, and a chart component.

## Data & API Design

### 1. Domain model

No dedicated domain model for this feature. It's a narrow read-side view over the same `TelemetrySnapshot` rows (`telemetry_snapshots` table, schema in `docs/vehicle-telemetry-polling/tech-spec.md`) already modeled for the `vehicle-state-log` feature. `Vehicle.stateLog(from, to)` is a shared resolver/DB query — no battery-health-trends-specific type, table, or query exists. This page's only distinguishing behavior is client-side: select `ts`/`batteryLevel` off the shared row shape and reverse the DESC-ordered result for chronological charting.

### 2. API design — GraphQL surface

**Schema** (`backend/src/graphql/schema.graphql`):

```graphql
type Vehicle {
  ...
  stateLog(from: DateTime, to: DateTime): [TelemetrySnapshot!]!
  ...
}

type TelemetrySnapshot {
  ts: DateTime!
  state: String
  batteryLevel: Int
  batteryRange: Float
  speed: Float
  lat: Float
  lng: Float
  heading: Int
  odometer: Float
  softwareVersion: String
  locked: Boolean
  climateOn: Boolean
  insideTemp: Float
  outsideTemp: Float
  doorState: JSON
  windowState: JSON
  tirePressure: JSON
}
```

`stateLog` is a non-null list (`[TelemetrySnapshot!]!`) — empty array, not null, when no rows fall in range. Only `ts`/`batteryLevel` are used by this page; every other field on `TelemetrySnapshot` (`state`, `batteryRange`, `speed`, `lat`, `lng`, `heading`, `odometer`, `softwareVersion`, `locked`, `climateOn`, `insideTemp`, `outsideTemp`, `doorState`, `windowState`, `tirePressure`) is fetched (per the frontend selection set in §3, a subset of these) or available but discarded client-side.

**Field resolver** (`backend/src/graphql/resolvers/types.js`, `Vehicle`):

| Field | Resolver | Behavior |
|---|---|---|
| `Vehicle.stateLog(from, to)` | `getStateLog(ctx.db, vehicle.id, from, to)` | Single query. `from`/`to` passed straight through; both optional/nullable — omitted or `null` means unbounded on that side (see §4). Result capped at `MAX_STATE_LOG_ROWS = 2000` regardless of range width. |

**Error cases:**

- `Query.vehicle(id)` (required parent, `requireOwnedVehicle` in `helpers.js`): `UNAUTHENTICATED` (`GraphQLError`, no `ctx.user`) if not logged in; `NOT_FOUND` if the vehicle doesn't exist or belongs to another user (ownership never leaked as a distinct `FORBIDDEN`) — same gate shared with `trips`/`chargingSessions`, no independent auth check on `stateLog` itself.
- `Vehicle.stateLog`: no additional error path — always resolves to an array (possibly empty, capped at 2000 rows); malformed `from`/`to` beyond `DateTime` scalar coercion is not validated in the resolver.

### 3. Frontend query

`frontend/src/graphql/queries/stateLog.js`:

```graphql
query VehicleStateLog($id: ID!, $from: DateTime, $to: DateTime) {
  vehicle(id: $id) {
    stateLog(from: $from, to: $to) {
      ts
      state
      batteryLevel
      batteryRange
      odometer
      locked
      climateOn
      insideTemp
      outsideTemp
      doorState
      windowState
    }
  }
}
```

Same query document (`VEHICLE_STATE_LOG_QUERY`) as `vehicle-state-log`, shared verbatim — not a battery-health-trends-specific query. `TrendsPage` reads only `ts`/`batteryLevel`; `state`, `batteryRange`, `odometer`, `locked`, `climateOn`, `insideTemp`, `outsideTemp`, `doorState`, `windowState` are fetched and unused. `speed`/`lat`/`lng`/`heading`/`softwareVersion`/`tirePressure` are not even in the selection set (not needed by either consuming feature).

### 4. DB query function

`backend/src/db/queries/telemetry.js` — reference only; full `telemetry_snapshots` schema in `docs/vehicle-telemetry-polling/tech-spec.md`.

```js
export async function getStateLog(db, vehicleId, from, to)
// SELECT ts, state, battery_level AS "batteryLevel", battery_range AS "batteryRange", speed,
//        lat, lng, heading, odometer, software_version AS "softwareVersion", locked,
//        climate_on AS "climateOn", inside_temp AS "insideTemp", outside_temp AS "outsideTemp",
//        door_state AS "doorState", window_state AS "windowState", tire_pressure AS "tirePressure"
// FROM telemetry_snapshots
// WHERE vehicle_id = $1
//   AND ts >= COALESCE($2::timestamptz, '-infinity') AND ts <= COALESCE($3::timestamptz, 'infinity')
// ORDER BY ts DESC
// LIMIT $4   -- MAX_STATE_LOG_ROWS = 2000
// → rows[] (possibly empty), most recent first
```

`MAX_STATE_LOG_ROWS = 2000` is a module-level constant, applied unconditionally — the cap holds even with no `from`/`to` supplied, since the poller can write as often as every 60s while driving and retention is permanent (comment in source: "2000 rows covers ~3 weeks of continuous 1-minute polling"). Ordering is `ts DESC`; `TrendsPage` reverses the array client-side before charting since a trend chart needs chronological (ascending) order.

**Files consulted** (read-only, not modified): `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/{query,types,helpers}.js`, `backend/src/db/queries/telemetry.js`, `frontend/src/graphql/queries/stateLog.js`, `frontend/src/pages/TrendsPage.jsx`, `frontend/src/components/charts/BatteryTrendChart.jsx`.
