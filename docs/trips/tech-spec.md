# Tech Spec — Trips

**Feature:** User-facing trip history read/query side (list + map)
**Status:** Already implemented and shipped. Grounded in `docs/trips/functional-spec.md`. The `trips`/`trip_points` table schema and capture logic are documented separately at `docs/vehicle-telemetry-polling/tech-spec.md` — not repeated here.

## Architecture

**Scope note:** this covers the read/query path for trip history only — list + map. The `trips`/`trip_points` table schema and the polling worker that populates them are out of scope here and already documented in `docs/vehicle-telemetry-polling/tech-spec.md`.

### Component map

```
Browser (React/MUI)
  TripsPage.jsx ──useQuery──▶ VEHICLE_TRIPS_QUERY  ─┐
       │                                             │  Apollo Client
       └──useQuery(skip)──▶ TRIP_ROUTE_QUERY        ─┘  (InMemoryCache, default normalization)
                                   │
                                   ▼  POST /graphql
Backend (GraphQL, Node)
  Query.vehicle(id) ──▶ requireOwnedVehicle(ctx, id) [auth + ownership gate]
       │
       └─ Vehicle.trips(limit, offset)  ──▶ getTripsByVehicle(db, vehicleId, ...)
       └─ Vehicle.trip(id)              ──▶ getTripById(db, vehicleId, id)
                │
                └─ Trip.route                    ──▶ getTripPoints(db, tripId)
                └─ Trip.efficiencyKmPerPercent    ──▶ pure function, no DB call
                                   │
                                   ▼
                              PostgreSQL (trips, trip_points — capture side, see telemetry-polling doc)
```

Everything below `Query.vehicle` inherits the ownership check from that single entry point — there is no independent authorization on `Trip.route` or `Trip.efficiencyKmPerPercent`; they trust that a `Trip` object could only have been resolved through an already-vehicle-scoped path.

### Decision: two separate queries (list vs. per-trip route), not one query with `route` inline

**What exists:** `VEHICLE_TRIPS_QUERY` fetches up to 30 trip summaries (no `route`). `TRIP_ROUTE_QUERY` is a distinct query, fired only for the currently-selected trip, `skip`ped when nothing is selected. Server-side this is mirrored by `Vehicle.trip(id)` being a separate field from `Vehicle.trips(...)`, each backed by its own DB query.

**Why this makes sense:** a trip's route is an unbounded set of GPS points (one per polling tick for the trip's duration), while the list only ever needs a handful of scalar summary fields. Embedding `route` in the list query would mean 30 trips' worth of breadcrumb data fetched on every page load regardless of whether the user ever looks at 29 of them. Splitting into two GraphQL operations lets the frontend request the expensive field lazily, exactly once, only for what's actually rendered.

**Rejected alternative:** a single query with `route` as a field, relying on the client to simply not request `route` for list rows and request it for the selected one via query variables/aliases. This was rejected implicitly by the code as it stands — GraphQL's field selection already gives per-field opt-in within *one* query shape, but that still couples the list's variables (`limit`) to the route's variables (`tripId`) in one request, forcing a full list refetch any time the selection changes. Two independent queries decouple "list rendering" from "selection changes" entirely — clicking a different trip re-fires only `TRIP_ROUTE_QUERY`, never `VEHICLE_TRIPS_QUERY`.

### Decision: Apollo cache needs no custom `typePolicies` for this to work correctly

**What exists:** `frontend/src/graphql/client.js` uses a bare `InMemoryCache()` with no type policies configured anywhere in the app.

**Why this makes sense:** every `Trip` returned by either query carries `id`, and every `Vehicle` carries `id`. Apollo's default normalization key is `__typename:id`, so both queries' `Trip` payloads land in the *same* normalized cache entry (`Trip:<id>`) even though they're fetched by different operations with different field selections. Practically: once `TRIP_ROUTE_QUERY` resolves for a trip already present from the list query, Apollo merges `route` into that trip's existing cache entry rather than creating a duplicate — so a `refetchQueries` or a `client.cache.readFragment` against that trip id would see both the summary fields and the route together, "for free," with zero cache configuration. This is why the two-query split doesn't need any bridging code on the frontend to reconcile the two responses into one object per trip — normalization does it.

**Consequence worth knowing downstream:** because there's no `typePolicies.Trip.fields.route` merge function, a route array update is a full replace (Apollo's default array field behavior), not an incremental merge. That's correct for this feature (a trip's `route` is immutable once written by the capture side) but would need attention if a "live in-progress trip" feature (explicitly out of scope per the functional spec) were ever added, since that would need route points to append rather than replace.

### Decision: map remounted via `key={selected.id}` rather than driven by prop updates

**What exists:** `frontend/src/components/Map.jsx` wraps `react-leaflet`'s `MapContainer`, receiving `center`/`zoom` as props. `TripsPage.jsx` renders `<Map key={selected.id} center=... />`.

**Why this makes sense:** `react-leaflet`'s `MapContainer` only applies `center`/`zoom` when the underlying Leaflet map instance is *created* — it does not re-center on prop changes after mount (this is a documented constraint of the library, not a bug in this codebase). Given that, the only way to make the camera actually move when the user selects a different trip is to force React to tear down and recreate the `MapContainer` instance, which `key` does cleanly — no imperative Leaflet API calls, no `useEffect` reaching into a map ref to call `.setView()` by hand.

**Rejected alternative:** hold a `ref` to the Leaflet map instance and imperatively call `map.setView(center, zoom)` in a `useEffect` keyed on `selected.id`. This would avoid the remount cost (tile re-fetch, marker re-render) but introduces an imperative escape hatch into an otherwise declarative component tree, and couples `Map.jsx` to Leaflet's imperative API surface instead of just its declarative props. For a page showing one map with a handful of tiles at a time (not a performance-sensitive map-heavy view), the remount cost is not a real constraint — the `key` approach was the smaller, more boring diff and is what shipped.

### Resolver structure

The read path is a small, flat resolver tree hanging off the existing `Query.vehicle` → `requireOwnedVehicle` gate (`backend/src/graphql/resolvers/query.js`, `helpers.js`) — no new authorization pattern was introduced for trips:

- `Query.vehicle(id)` calls `requireOwnedVehicle`, which throws `UNAUTHENTICATED` (no session) or `NOT_FOUND` (vehicle exists but isn't the caller's) — deliberately not `FORBIDDEN`, so vehicle existence isn't leaked to non-owners.
- `Vehicle.trips(limit, offset)` and `Vehicle.trip(id)` (`types.js`) are independent field resolvers on the already-authorized `Vehicle`, each issuing a vehicle-scoped DB query (`getTripsByVehicle` / `getTripById`, both filtered `WHERE vehicle_id = $1`).
- `Trip.route` and `Trip.efficiencyKmPerPercent` hang off `Vehicle.trip`'s result, not off `Vehicle.trips` — so requesting one trip's route can never trigger a route fetch for the other 29 list rows, and the DB-level trip scoping (`WHERE vehicle_id = $1 AND id = $2` in `getTripById`) means a trip id can't be walked across vehicle boundaries even by a user who owns *some* vehicle.

**Why this makes sense:** it reuses the exact ownership-gating pattern already established for every other `Vehicle`-scoped field (`latestSnapshot`, `chargingSessions`, `stateLog`) rather than inventing a trips-specific authorization mechanism. No new middleware, no new context field, no separate "can this user see this trip" check — ownership is proven once at `vehicle(id)` and re-proven at the trip-id level purely via a `WHERE` clause, which is the same amount of code an equivalent check-function would have cost but without adding a second authorization pathway to reason about.

### Decision: `efficiencyKmPerPercent` computed at read time, not persisted

**What exists:** `Trip.efficiencyKmPerPercent` in `types.js` is a plain function (`distanceKm / (startBatteryLevel - endBatteryLevel)`, null-guarded, null when net usage ≤ 0) run per-request — it is not a column on `trips`.

**Why this makes sense:** the inputs (`distanceKm`, `startBatteryLevel`, `endBatteryLevel`) are already stored; efficiency is a pure derivation with no external state and negligible compute cost (one subtraction, one division, per row, per request — max 30 times per list load). Storing it would mean either recomputing and writing it every time the source columns are corrected/backfilled by the capture side, or risking a stored value drifting from its inputs. A GraphQL field resolver keeps the derivation co-located with its business rule (the "null when usage isn't positive" guard) in one place, visible to anyone reading the schema, rather than splitting that rule between a write-time calculation and a read-time display check.

**Rejected alternative:** compute and store `efficiency_km_per_percent` as a column at trip-close time (in the capture worker). Rejected because it would duplicate a derivation rule across two layers (capture-side write logic and read-side schema/UI expectations) for a value cheap enough to compute on every read, and because it would need a backfill/migration story for any future change to the null-guard rule (e.g., if the "usage ≤ 0 → null" threshold is revisited) — a read-time resolver changes behavior for all historical trips with a one-line diff, no migration.

### Security / data-boundary notes for handoff

- **Ownership boundary is enforced exactly once, at `vehicle(id)`, and re-checked at the trip-id level** via the `WHERE vehicle_id = $1 AND id = $2` clause in `getTripById` — there is no independent check on `Trip.route`; it inherits trust from its parent. Any future field added under `Trip` inherits this same trust boundary automatically as long as it stays under `Vehicle.trip`/`Vehicle.trips`. If a resolver is ever added that fetches a `Trip` by id from somewhere *other* than `Vehicle.trip`/`Vehicle.trips` (e.g., a hypothetical top-level `Query.trip(id)`), it would bypass this vehicle-scoping and needs its own ownership check — flagging so this isn't assumed automatically safe by pattern-matching on `Trip`.
- **Error-type masking (`NOT_FOUND` vs `FORBIDDEN`)** is deliberate at the `vehicle` resolver and should be preserved in this form — it prevents a user from distinguishing "vehicle doesn't exist" from "vehicle exists but isn't mine" via error inspection.
- **GPS route data (`Trip.route` → `trip_points`) is the most sensitive payload on this page** — it's a full breadcrumb of a vehicle's (and by extension, likely the owner's) movements, more sensitive than the summary fields. It rides on the same ownership gate as everything else here, with no additional access control (e.g., no separate consent/sharing scope) — worth an explicit flag if trip-sharing between users is ever considered, since today ownership is strictly one-to-one (`vehicle.userId`).
- **No rate limiting or query-cost analysis is present** on `Vehicle.trips`/`Vehicle.trip` beyond the client-side fixed `limit: 30` — the schema-level `offset` parameter is unbounded server-side; this is inherited from the general GraphQL setup, not specific to trips, and is out of scope to fix here but worth naming for the Security Engineer.

## Data & API Design

### 1. Domain model

Read-side only — no new tables. `Trip` and `TripPoint` are GraphQL projections of the `trips` / `trip_points` tables already defined in `docs/vehicle-telemetry-polling/tech-spec.md` (§ Data & API Design, "Database schema"); this feature adds no migration.

- **Vehicle** `1 --- *` **Trip**, exposed as two independent field resolvers on `Vehicle`: `trips(limit, offset)` (list, no child data) and `trip(id)` (single row, with its `route` child resolvable). Both resolvers query `trips` directly, scoped `WHERE vehicle_id = $1`; there is no resolver-level relation object shared between them.
- **Trip** `1 --- *` **TripPoint**, exposed only as `Trip.route`, itself only reachable through `Vehicle.trip(id)` — `Vehicle.trips` never resolves `route`, so a 30-row trip list makes exactly 1 DB query (`getTripsByVehicle`), not 31.
- **Trip.efficiencyKmPerPercent** is not a stored column — it's a derived field computed in the resolver layer (`efficiencyKmPerPercent` in `backend/src/graphql/resolvers/types.js`) from three already-selected columns (`distanceKm`, `startBatteryLevel`, `endBatteryLevel`), independent of `route`/`TripPoint` and available on both `Vehicle.trips` and `Vehicle.trip` results since it only depends on fields both queries already select.

Ownership: neither `getTripsByVehicle` nor `getTripById`/`getTripPoints` checks the requesting user — authorization happens once, upstream, in `Query.vehicle` via `requireOwnedVehicle` (`backend/src/graphql/resolvers/helpers.js`). `Vehicle.trips`/`Vehicle.trip` only ever run against an already-ownership-checked parent `vehicle` object, so a trip ID belonging to another user's vehicle can't be looked up through this path (see `getTripById`'s `vehicle_id` scoping below).

### 2. API design — GraphQL surface

**Schema** (`backend/src/graphql/schema.graphql`):

```graphql
type Vehicle {
  ...
  trips(limit: Int, offset: Int): [Trip!]!
  trip(id: ID!): Trip
  ...
}

type Trip {
  id: ID!
  startTime: DateTime!
  endTime: DateTime
  distanceKm: Float
  durationSeconds: Int
  startLat: Float
  startLng: Float
  endLat: Float
  endLng: Float
  startBatteryLevel: Int
  endBatteryLevel: Int
  efficiencyKmPerPercent: Float
  route: [TripPoint!]!
}

type TripPoint {
  ts: DateTime!
  lat: Float!
  lng: Float!
  speed: Float
}
```

All `Trip` scalar fields besides `id`/`startTime` are nullable, matching the underlying columns' nullability (open trips have `endTime`/`endLat`/`endLng`/`distanceKm`/`durationSeconds`/`endBatteryLevel` all NULL until `closeTripIfOpen` runs — see telemetry-polling spec). `route` is non-null list (`[TripPoint!]!`) — an empty array, not null, when a trip has no points.

**Field resolvers** (`backend/src/graphql/resolvers/types.js`, `Vehicle` / `Trip`):

| Field | Resolver | Behavior |
|---|---|---|
| `Vehicle.trips(limit, offset)` | `getTripsByVehicle(ctx.db, vehicle.id, limit, offset)` | Independent query, one call regardless of list size. `limit`/`offset` passed straight through (undefined args fall through to the DB function's defaults, `limit=50, offset=0` — see §3). No upper bound enforced on `limit` at the resolver or SQL layer. |
| `Vehicle.trip(id)` | `getTripById(ctx.db, vehicle.id, id)` | Independent query, scoped by both `vehicle.id` (from the already-ownership-checked parent) and `id`. Returns `null` (not an error) when no matching row — schema reflects this via nullable `Trip` return type. |
| `Trip.route` | `getTripPoints(ctx.db, trip.id)` | Only invoked when a query selects `route` under `Vehicle.trip(id)`; never invoked from a `Vehicle.trips` selection set since no such parent chain reaches it. |
| `Trip.efficiencyKmPerPercent` | pure function `efficiencyKmPerPercent({distanceKm, startBatteryLevel, endBatteryLevel})` | No DB call. `null` if any of the three inputs is `null`, or if `startBatteryLevel - endBatteryLevel <= 0` (net non-positive usage, e.g. regen/charging offsetting the trip). |

**Error cases:**

- `Query.vehicle(id)` (the required parent for both fields): `UNAUTHENTICATED` (`GraphQLError`, no `ctx.user`) if not logged in; `NOT_FOUND` if the vehicle doesn't exist or belongs to another user (ownership never leaked as a distinct `FORBIDDEN`). Both `trips` and `trip` inherit this gate — neither is independently reachable without a resolved `vehicle`.
- `Vehicle.trips`: no additional error path — always resolves to an array (possibly empty); malformed `limit`/`offset` (e.g. negative) is passed to Postgres as-is (`LIMIT`/`OFFSET` params), not validated in the resolver.
- `Vehicle.trip(id)`: no throw for a missing/foreign trip id — resolves to `null`, consistent with the nullable `Trip` return type; client-side must treat `null` as "not found," not as a network/GraphQL error.
- `Trip.route`, `Trip.efficiencyKmPerPercent`: no error paths of their own; both only run once `Vehicle.trip(id)` has already resolved a non-null `Trip`.

**Frontend query documents** (`frontend/src/graphql/queries/trips.js`):

- **`VEHICLE_TRIPS_QUERY($id: ID!, $limit: Int, $offset: Int)`** — selects `vehicle(id: $id) { trips(limit: $limit, offset: $offset) { id startTime endTime distanceKm durationSeconds startLat startLng endLat endLng startBatteryLevel endBatteryLevel efficiencyKmPerPercent } }`. No `route` in the selection set — this is the list view, deliberately kept off breadcrumb data (per code comment on the schema's `Vehicle.trip` field and the query file's own comment).
- **`TRIP_ROUTE_QUERY($vehicleId: ID!, $tripId: ID!)`** — selects `vehicle(id: $vehicleId) { trip(id: $tripId) { id route { ts lat lng speed } } }`. Fetched lazily per selected trip (one query per trip drill-down), not inline on the list query. Note the two variable names differ from the list query's single `$id` (`$vehicleId`/`$tripId` vs `$id`/`$limit`/`$offset`) — both queries target the same `Vehicle.id` value at the variables layer, just under different variable names per query.

Both queries return `Trip` objects with the same `id` field, so Apollo's default (uncustomized) InMemoryCache normalization merges a list-fetched `Trip:<id>` and a route-fetched `Trip:<id>` into one cache entry — a component reading a `Trip` from the list after its route has been separately fetched will see `route` populated without a third query, and no `typePolicies` are defined for `Trip` to make this work (relies entirely on default `id`-based normalization, consistent with the Architecture section above).

### 3. DB query functions consumed

`backend/src/db/queries/trips.js` — reference only; full `trips`/`trip_points` schema already documented in `docs/vehicle-telemetry-polling/tech-spec.md`.

```js
// SELECT_FIELDS: id, start_time AS "startTime", end_time AS "endTime",
// distance_km AS "distanceKm", duration_seconds AS "durationSeconds",
// start_lat/start_lng/end_lat/end_lng, start_battery_level AS "startBatteryLevel",
// end_battery_level AS "endBatteryLevel"  (camelCase aliasing, no route/points)

getTripsByVehicle(db, vehicleId, limit = 50, offset = 0)
// SELECT <fields> FROM trips WHERE vehicle_id = $1
// ORDER BY start_time DESC LIMIT $2 OFFSET $3
// → rows[] (possibly empty), most recent trip first

getTripById(db, vehicleId, tripId)
// SELECT <fields> FROM trips WHERE vehicle_id = $1 AND id = $2
// → rows[0] || null — vehicleId-scoped so a trip id belonging to
// another user's vehicle can't be looked up via this function even
// if the id were guessed/leaked

getTripPoints(db, tripId)
// SELECT ts, lat, lng, speed FROM trip_points WHERE trip_id = $1
// ORDER BY ts ASC
// → rows[] (possibly empty) — no vehicle_id scoping (not needed:
// only ever called with a trip.id already resolved through the
// vehicle_id-scoped getTripById above)
```

`limit`/`offset` defaults (`50`/`0`) live in `getTripsByVehicle`'s JS default parameters, not in the GraphQL schema (`trips(limit: Int, offset: Int)` has no `= 50` default) — an explicit `null` passed from a client would bypass the JS default and hit Postgres as `LIMIT NULL`, not `LIMIT 50`; only an *omitted* argument (`undefined`) falls through to the default.

**Files consulted** (read-only, not modified): `frontend/src/pages/TripsPage.jsx`, `frontend/src/components/Map.jsx`, `frontend/src/graphql/queries/trips.js`, `frontend/src/graphql/client.js`, `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/{query,types,helpers}.js`, `backend/src/db/queries/trips.js`.
