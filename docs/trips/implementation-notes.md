# Implementation Notes — Trips

**Status:** shipped, read-only feature (trip history list + map). No code was changed while producing these notes — this is a verification pass over the existing implementation described in `docs/trips/tech-spec.md`.

## Summary

The trips feature lets a user view their vehicle's trip history as a list (up to 30 most recent trips, each showing distance/duration/battery-used/efficiency) and, on selecting a trip, see its GPS route drawn as a polyline on a Leaflet map. It is entirely a read path over the `trips`/`trip_points` tables already populated by the telemetry-polling worker (out of scope here) — no migrations, no mutations, no new tables were added for this feature.

The implementation matches the tech spec closely: two independent GraphQL queries (list vs. route), a flat resolver tree inheriting a single ownership check from `Query.vehicle`, and a derived (non-persisted) efficiency field.

## Key files and their role

**Frontend**
- `frontend/src/pages/TripsPage.jsx` — page component. Runs `VEHICLE_TRIPS_QUERY` (limit 30) for the list, tracks `selectedId` in local state (defaults to the first trip once loaded), and runs `TRIP_ROUTE_QUERY` (`skip: !selected`) only for the currently selected trip. Renders the list as an MUI `List`/`ListItemButton` and the map via the local `Map` component, passing a `Polyline` built from `route` as `children`.
- `frontend/src/components/Map.jsx` — thin wrapper around `react-leaflet`'s `MapContainer` + `TileLayer` (OpenStreetMap tiles), plus a one-time fix for Leaflet's default marker icon URLs not resolving under Vite (`delete L.Icon.Default.prototype._getIconUrl` + `mergeOptions` pointing at bundled marker images). Takes `center`, `zoom` (default 15), `height` (default 300), `children`.
- `frontend/src/graphql/queries/trips.js` — the two query documents, `VEHICLE_TRIPS_QUERY` and `TRIP_ROUTE_QUERY`, matching the schema fields documented in the tech spec exactly (list query has no `route` selection; route query selects `id route { ts lat lng speed }` only).

**Backend**
- `backend/src/graphql/resolvers/query.js` — `Query.vehicle` is the single entry point (`requireOwnedVehicle(ctx, id)`); no `Query.trip`/`Query.trips` exists at the top level, so trips are unreachable except through an already-owned `Vehicle`.
- `backend/src/graphql/resolvers/helpers.js` — `requireOwnedVehicle` throws `UNAUTHENTICATED` (no session) or `NOT_FOUND` (vehicle missing or owned by someone else — deliberately not `FORBIDDEN`, so ownership isn't leaked via error type).
- `backend/src/graphql/resolvers/types.js` — `Vehicle.trips`/`Vehicle.trip` call `getTripsByVehicle`/`getTripById` respectively; `Trip.route` calls `getTripPoints`; `Trip.efficiencyKmPerPercent` is a pure function (`distanceKm / (startBatteryLevel - endBatteryLevel)`, null-guarded, `null` when net usage ≤ 0), exported standalone for testing.
- `backend/src/db/queries/trips.js` — `getTripsByVehicle(db, vehicleId, limit=50, offset=0)`, `getTripById(db, vehicleId, tripId)`, `getTripPoints(db, tripId)`. Both trip-level queries are scoped `WHERE vehicle_id = $1`; `getTripPoints` is not vehicle-scoped (relies on `trip.id` only ever arriving already vehicle-scoped via `getTripById`).
- `backend/src/graphql/schema.graphql` — `Vehicle.trips(limit, offset)` / `Vehicle.trip(id)`, `Trip`, `TripPoint` types; matches the tech spec's documented shape, including the comment noting `route` is deliberately kept off the list query.

## Notable decisions / gotchas confirmed while reading

- **Two separate queries, not one with inline `route`.** Confirmed in both the query file (comment) and schema (comment on `trip(id)`): the list query never selects `route`, avoiding 30x breadcrumb fetches per page load. `TripsPage.jsx` fires `TRIP_ROUTE_QUERY` with `skip: !selected`, so it doesn't fire at all until a trip is selected (and `selected` defaults to `trips[0]` once the list loads, so it fires once immediately after list load in the common case).
- **No Apollo `typePolicies`.** Not directly visible in the files reviewed here (`client.js` wasn't part of this read, per the task's file list, but is referenced by the tech spec) — taken as given from the tech spec; nothing in `TripsPage.jsx` works around missing cache config, consistent with that claim.
- **Map remount via `key={selected.id}`.** Confirmed in `TripsPage.jsx` line 75 with an inline comment explaining why (`MapContainer` only applies `center`/`zoom` on mount). No imperative Leaflet ref/`setView` calls anywhere in `Map.jsx`.
- **Efficiency computed at read time.** `efficiencyKmPerPercent` in `types.js` is a plain exported function, not a DB column — confirmed absent from `SELECT_FIELDS` in `trips.js`. Guard order: null-check the three inputs first, then reject non-positive usage (`used <= 0`) — regen/charging that raises battery level during a trip yields `null`, not a negative/nonsensical efficiency.
- **Ownership checked exactly once.** `Trip.route` and `Trip.efficiencyKmPerPercent` resolvers take no `ctx.user`/ownership args at all — they trust `trip` already came from a vehicle-scoped `getTripById`/`getTripsByVehicle` call. Confirmed no independent auth check exists anywhere under `Trip`.
- **`getTripPoints` is unscoped by vehicle.** By design (comment in `trips.js` confirms), since it's only ever invoked with a `trip.id` that already passed through `getTripById`'s `vehicle_id` filter. This is a real trust dependency on resolver wiring, not the DB layer — worth flagging again here since it's the one place in this feature where a future refactor (e.g., a hypothetical top-level `Query.trip(id)`, explicitly called out in the tech spec) could silently reintroduce a cross-vehicle leak if `Trip.route` were ever reached from a non-`Vehicle.trip` path.
- **`limit`/`offset` are unbounded/unvalidated.** `getTripsByVehicle`'s JS defaults (`limit=50, offset=0`) only apply when the arg is `undefined`; the frontend always passes `limit: 30` explicitly and never passes `offset`, so this edge case (explicit `null` bypassing the default) isn't hit by the current UI, but the resolver itself does nothing to prevent it.
- **Minor doc/code mismatch:** tech spec's Vehicle.trips resolver row states "no upper bound enforced on `limit`... at the resolver or SQL layer" — confirmed true; also worth noting the frontend hardcodes `limit: 30` as a query variable rather than a query default, so if a caller ever reused `VEHICLE_TRIPS_QUERY` without passing `limit`, it would fall through to the DB's default of 50, not 30.

## Test verification

Ran the existing backend suite (`cd backend && npm test`, i.e. `node --test $(find src -name '*.test.js')`):

```
✔ 13/13 passing (0 failing)
```

Directly relevant to trips:
- `backend/src/graphql/resolvers/types.test.js` — 3 tests, all passing. Covers `efficiencyKmPerPercent`: normal division, `null` on missing battery levels, `null` on non-positive net usage. Does **not** test `Vehicle.trips`/`Vehicle.trip`/`Trip.route` resolvers themselves (no DB-mocked resolver test), only the pure `efficiencyKmPerPercent` function.
- `backend/src/graphql/resolvers/helpers.test.js` — 3 tests, all passing. Covers `requireOwnedVehicle`: owner success, `NOT_FOUND` for another user's vehicle, `UNAUTHENTICATED` with no user. This is the shared ownership gate that `Query.vehicle` (and transitively all of `Vehicle.trips`/`Vehicle.trip`) depends on — covered, but generically (not trips-specific).

Not covered by any existing test:
- `backend/src/db/queries/trips.js` — no `trips.test.js` exists (compare to `backend/src/db/queries/telemetry.test.js`, which does exist for a sibling query module). The SQL in `getTripsByVehicle`/`getTripById`/`getTripPoints` (vehicle-scoping `WHERE` clauses, `ORDER BY`/`LIMIT`/`OFFSET`) is unverified by an automated test — verified only by manual code reading here.
- `backend/src/graphql/resolvers/query.js` (`Query.vehicle`) and `types.js`'s `Vehicle`/`Trip` resolver object itself — no resolver-level test wiring a fake `ctx.db` through `Vehicle.trips`/`Vehicle.trip`/`Trip.route`; only the extracted pure function and the extracted auth helper are unit-tested, not the resolver glue connecting them.
- Frontend — no test runner configured in the monorepo at all (`frontend/package.json` has no `test` script; no vitest/jest config found at the repo root or in `frontend/`). `TripsPage.jsx` and `Map.jsx` have zero automated test coverage; verification is manual/visual only. No frontend test files exist for this feature (or any feature in `frontend/`).

Per the task, no new tests were written — this section only reports what exists and what was run.

## Files consulted (read-only)

`docs/trips/tech-spec.md`, `frontend/src/pages/TripsPage.jsx`, `frontend/src/components/Map.jsx`, `frontend/src/graphql/queries/trips.js`, `backend/src/graphql/resolvers/query.js`, `backend/src/graphql/resolvers/types.js`, `backend/src/graphql/resolvers/helpers.js`, `backend/src/db/queries/trips.js`, `backend/src/graphql/schema.graphql` (partial, `trips`/`trip` fields only), `backend/src/graphql/resolvers/types.test.js`, `backend/src/graphql/resolvers/helpers.test.js`, `backend/package.json`, `frontend/package.json`, root `package.json`.
