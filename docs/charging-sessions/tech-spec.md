# Tech Spec — Charging Sessions

**Feature:** User-facing charging session history read/query side (flat table, no map)
**Status:** Already implemented and shipped. Grounded in `docs/charging-sessions/functional-spec.md`. The `charging_sessions` table schema and capture logic are documented separately at `docs/vehicle-telemetry-polling/tech-spec.md` — not repeated here.

## Architecture

**Component map:** `ChargingPage.jsx` → `VEHICLE_CHARGING_QUERY` (Apollo, default `cache-first`) → `Query.vehicle` → `requireOwnedVehicle` (auth + ownership check, `helpers.js`) → `Vehicle.chargingSessions` field resolver (`types.js`) → `getChargingSessionsByVehicle` (`db/queries/charging.js`) → single indexed SELECT against `charging_sessions`, `ORDER BY start_time DESC LIMIT/OFFSET`. No service layer, no caching layer beyond Apollo's client cache, no separate REST endpoint. Table population/ingestion is out of scope here — see `docs/vehicle-telemetry-polling/tech-spec.md`.

This is not a distinct architecture — it's the same "GraphQL field resolver on `Vehicle` → parameterized SQL query, list capped and offset via query args" pattern already established by `Vehicle.trips`/`getTripsByVehicle`, reused verbatim with a different table and column set. Same auth boundary (`requireOwnedVehicle`, anti-enumeration `NOT_FOUND`), same pagination shape (`limit`/`offset`, no cursor), same "no dedicated backend endpoint per feature" convention. Nothing here required a new pattern, so there's no ADR to write for the shape of the integration itself.

One thing worth flagging at the architecture level rather than purely functional: `lat`/`lng` are selected in the DB query and returned by the resolver (and requested by the frontend query) but never rendered by `ChargingPage`. This isn't a bug in this feature's logic — it's the resolver/query exposing the full `charging_sessions` row shape (same columns available for a location-aware consumer, e.g. Trips-style map view) rather than a session-detail-specific projection. Worth a note for the Security Engineer: no sensitive-data concern beyond what's already true of trip coordinates, but it's dead weight on the wire for this page and a candidate for a narrower query/field set if this page's payload size ever matters.

## Data & API Design

### 1. Domain model

Read-side only — no new tables. `ChargingSession` is a GraphQL projection of the `charging_sessions` table already defined in `docs/vehicle-telemetry-polling/tech-spec.md` (§ Data & API Design, "Database schema"); this feature adds no migration.

- **Vehicle** `1 --- *` **ChargingSession**, exposed as a single field resolver: `Vehicle.chargingSessions(limit, offset)`. No per-session drill-down field (unlike `Trip`/`Trip.route`) — the full row shape is returned in one query, there is no separate "detail" query for one session.
- No derived fields — every `ChargingSession` field is a direct column projection (camelCase-aliased), unlike `Trip.efficiencyKmPerPercent` which is computed in the resolver layer. `lat`/`lng` are selected and returned as-is but are not consumed anywhere in the frontend selection set (see §2) — full-row exposure, not a narrow projection tailored to current UI use.

Ownership: `getChargingSessionsByVehicle` does not check the requesting user — authorization happens once, upstream, in `Query.vehicle` via `requireOwnedVehicle` (`backend/src/graphql/resolvers/helpers.js`). `Vehicle.chargingSessions` only ever runs against an already-ownership-checked parent `vehicle` object.

### 2. API design — GraphQL surface

**Schema** (`backend/src/graphql/schema.graphql`):

```graphql
type Vehicle {
  ...
  chargingSessions(limit: Int, offset: Int): [ChargingSession!]!
  ...
}

type ChargingSession {
  id: ID!
  startTime: DateTime!
  endTime: DateTime
  startBatteryLevel: Int
  endBatteryLevel: Int
  energyAddedKwh: Float
  lat: Float
  lng: Float
}
```

All fields besides `id`/`startTime` are nullable, matching underlying column nullability (an in-progress/open session has `endTime`/`endBatteryLevel` NULL until closed). `chargingSessions` itself is a non-null list (`[ChargingSession!]!`) — empty array, not null, when a vehicle has no sessions in range.

**Field resolver** (`backend/src/graphql/resolvers/types.js`, `Vehicle`):

| Field | Resolver | Behavior |
|---|---|---|
| `Vehicle.chargingSessions(limit, offset)` | `getChargingSessionsByVehicle(ctx.db, vehicle.id, limit, offset)` | Single query, one call regardless of list size. `limit`/`offset` passed straight through — undefined args fall through to the DB function's JS defaults (`limit=50, offset=0`, see §3). No upper bound enforced on `limit` at the resolver or SQL layer. |

**Error cases:**

- `Query.vehicle(id)` (required parent): `UNAUTHENTICATED` (`GraphQLError`, no `ctx.user`) if not logged in; `NOT_FOUND` if the vehicle doesn't exist or belongs to another user (ownership never leaked as a distinct `FORBIDDEN`) — same gate as `trips`/`stateLog`, no independent auth check on `chargingSessions` itself.
- `Vehicle.chargingSessions`: no additional error path — always resolves to an array (possibly empty); malformed `limit`/`offset` (e.g. negative) is passed to Postgres as-is, not validated in the resolver.

**Frontend query document** (`frontend/src/graphql/queries/charging.js`):

- **`VEHICLE_CHARGING_QUERY($id: ID!, $limit: Int, $offset: Int)`** — selects `vehicle(id: $id) { chargingSessions(limit: $limit, offset: $offset) { id startTime endTime startBatteryLevel endBatteryLevel energyAddedKwh lat lng } }`. Full `ChargingSession` field set is selected including `lat`/`lng`, even though nothing in the frontend currently renders them (no map/location UI for charging sessions today).

### 3. DB query function consumed

`backend/src/db/queries/charging.js` — reference only; full `charging_sessions` schema already documented in `docs/vehicle-telemetry-polling/tech-spec.md`.

```js
getChargingSessionsByVehicle(db, vehicleId, limit = 50, offset = 0)
// SELECT id, start_time AS "startTime", end_time AS "endTime",
//        start_battery_level AS "startBatteryLevel", end_battery_level AS "endBatteryLevel",
//        energy_added_kwh AS "energyAddedKwh", lat, lng
// FROM charging_sessions WHERE vehicle_id = $1
// ORDER BY start_time DESC LIMIT $2 OFFSET $3
// → rows[] (possibly empty), most recent session first
```

`limit`/`offset` defaults (`50`/`0`) live in the function's JS default parameters, not the GraphQL schema (`chargingSessions(limit: Int, offset: Int)` has no `= 50` default) — same convention as `getTripsByVehicle`: an explicit `null` from a client bypasses the JS default and hits Postgres as `LIMIT NULL`; only an *omitted* argument falls through.

**Files consulted** (read-only, not modified): `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/{query,types,helpers}.js`, `backend/src/db/queries/charging.js`, `frontend/src/graphql/queries/charging.js`.
