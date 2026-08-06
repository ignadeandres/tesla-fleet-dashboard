# Tech Spec — Dashboard Overview

**Feature:** Per-vehicle Overview page (landing page) + Vehicle Selector
**Status:** Already implemented and shipped. Grounded in `docs/dashboard-overview/functional-spec.md`. The `telemetry_snapshots` table schema is documented separately at `docs/vehicle-telemetry-polling/tech-spec.md` — not repeated here.

## Architecture

### ADR: `getLatestSnapshot` resolves the sleep-fallback via two sequential queries, not one query with `COALESCE`/window functions

**Decision:** `backend/src/db/queries/telemetry.js`'s `getLatestSnapshot` runs a first query for the single newest row (`ORDER BY ts DESC LIMIT 1`), and only if that row's `odometer IS NULL` does it run a second query for the newest row where `odometer IS NOT NULL`, then splices the first row's `state`/`ts` onto the second row's other fields.

**Alternative considered:** a single query using a window function (e.g. `LAST_VALUE(...) IGNORE NULLS OVER (ORDER BY ts)` — not available in Postgres without workarounds — or a `DISTINCT ON` + `COALESCE` per column) to produce "state/ts from the newest row, every other field from the newest row that has it" in one round trip.

**Why the existing two-query shape makes sense:** the fallback need is narrow and asymmetric — it's not "backfill every column independently from its own most-recent non-null value" (which is what a per-column `COALESCE`/window approach would naturally express, and is more than this feature does), it's "state/ts always come from the single newest row; every other field comes from a single other row, as a unit, or not at all" (per functional-spec Story 4's business rule: no per-column merging). Expressing "two rows, whole-row swap on one boolean condition" as a window function would be less direct than the two plain, indexable queries already written, and this endpoint runs on every Overview page load — not a hot path where a second round trip to `telemetry_snapshots` (indexed on `(vehicle_id, ts DESC)` per `docs/vehicle-telemetry-polling/tech-spec.md`) is a meaningful cost. The second query only executes at all when the fast path (`latest.odometer != null`) misses, which is the common case once a vehicle has a few readings, so the two-query cost is paid rarely, not on every call. Postgres/`pg` version portability (this app is not on a Postgres version pinned to guarantee `IGNORE NULLS` support) is a secondary reason the straightforward two-query form was the easier correct choice.

**Tradeoff accepted:** "state+ts from the newest row, everything else from the most-recent-with-data row" means the UI can show a state (e.g. "asleep") whose timestamp is newer than the battery/location numbers displayed alongside it — a real skew, not a bug, and already called out in functional-spec Story 4 as accepted behavior. The fallback is also only one hop deep (no further walk-back if the fallback row is itself incomplete), which keeps the query pair fixed at exactly two round trips regardless of how many consecutive bare state-transition rows exist for a vehicle, rather than degrading toward an unbounded scan.

### ADR: `refreshVehicle` blocks synchronously on wake-and-wait (~15s worst case) instead of returning immediately and letting the client poll

**Decision:** `backend/src/graphql/resolvers/mutation.js`'s `refreshVehicle` mutation, when it finds the vehicle asleep, sends the wake command and then loops up to 5 times (3s apart) re-checking `getVehicleLite` before either proceeding to the full poll or throwing `VEHICLE_UNREACHABLE` — the GraphQL request itself stays open for up to ~15 seconds.

**Alternative considered:** return immediately after issuing the wake command (e.g. a `202`-style "waking" response or a job id), and have the frontend poll a status query or re-issue the mutation until the vehicle reports awake.

**Why the existing synchronous design makes sense:** this is a single manually-triggered action behind a button click, not a background or bulk operation — the frontend's actual handling (per `docs/dashboard-overview/functional-spec.md` Story 3) is already exactly "disable the button, show 'Refreshing…', wait for the promise to settle," which is precisely what a single blocking mutation gives it for free. Building a polling protocol (a second query, client-side interval, a way to correlate "is this poll for the same refresh attempt") is real surface area that only pays for itself if the wait were long or unbounded or needed to survive a page navigation — at a hard-capped ~15s ceiling for one specific user-initiated click, Apollo's existing mutation-in-flight state (`loading`/`error`) already covers the UX with no new frontend machinery. The rate limiter (see below) bounds how often this ~15s blocking cost can even be incurred per vehicle, which is part of why leaving it synchronous doesn't become a resource problem under repeated clicks.

**Tradeoff accepted:** the backend request-handling thread/connection is held open for up to 15s per in-flight wake, and a slow or hung Tesla API response during that window extends the mutation's total duration with it — acceptable at this app's scale (one manual click per vehicle per rate-limit window) but would not extend to a bulk "refresh all vehicles" action without revisiting this shape.

### ADR: `refreshVehicle`'s per-vehicle rate limiter is an in-memory `Map`, not a DB-persisted counter

**Decision:** `lastRefreshAt` is a module-level `Map<vehicleId, timestamp>` checked and updated in-process, resetting to empty on every backend restart/deploy.

**Alternative considered:** a DB-persisted rate-limit table (analogous to `vehicle-telemetry-polling`'s `api_call_budget` table), surviving process restarts.

**Why in-memory is acceptable here, unlike `api_call_budget`:** this is the same tradeoff class as the worker's in-memory trip/charging-session tracking documented in `docs/vehicle-telemetry-polling/tech-spec.md` — a single backend process, one `Map`, reset-on-restart is fine as long as the failure mode of a reset is bounded and cheap, not a compliance/billing problem. Here, a backend restart at worst lets one user issue one extra manual refresh sooner than 60s after the last — a single additional Tesla API call for one vehicle, not a fleet-wide budget breach. That is categorically different from `api_call_budget`'s job, which is protecting a hard, billed, fleet-wide daily quota against exactly this kind of reset (per that document's ADR, motivated by a real prior incident); persisting `lastRefreshAt` to Postgres to guard against an occasional extra manual click would be new infrastructure protecting a risk this feature doesn't actually have. The two rate limiters are deliberately inconsistent in persistence for this reason, not by oversight.

**Tradeoff accepted:** `backend` is assumed single-process for this guarantee to hold at all — if `backend` were ever horizontally scaled behind a load balancer, each instance would carry its own `lastRefreshAt` map and the effective rate limit would loosen by a factor of the instance count, since nothing coordinates the map across processes. No such scaling exists today; this is a documented ceiling, not a current problem.

### VehicleSelector's section-preserving navigation

Not a distinct architectural decision — `VehicleSelector.jsx`'s `onChange` handler reuses `sectionFromPath` (`frontend/src/utils/section.js`), the same path-segment-4 parsing utility already established for this purpose elsewhere in the app, to compute `/v/{newVehicleId}/{currentSection}` on vehicle switch. This is ordinary code reuse of an existing small utility, not a new pattern introduced for this feature.

### Security / data-boundary notes for handoff

- `refreshVehicle`'s wake-and-wait loop and the full-state fetch both run using the requesting user's already-verified `vehicle` ownership (`requireOwnedVehicle`, checked once at the top of the mutation, before the rate-limit check and before any Tesla API call) — no re-check occurs mid-loop, so ownership is validated exactly once per invocation, at the earliest point, which is correct as long as ownership cannot change mid-request (it cannot, in the current schema — vehicles are not transferable between users).
- The in-memory rate limiter is keyed on internal `vehicle.id` (already ownership-scoped by the time it's consulted), not on user or IP, so it throttles *the vehicle*, not the caller — this is a shared-resource limiter (protecting Tesla's per-vehicle API surface), not an anti-abuse control on the user, and should not be relied on as one.
- `getLatestSnapshot`'s fallback query has no ownership filter of its own (`vehicle_id` is trusted as passed in) — it is only ever called from resolvers (`Vehicle.latestSnapshot`, the tail of `refreshVehicle`) that have already run `requireOwnedVehicle` upstream; calling it directly with an unverified `vehicleId` would leak another user's telemetry, so ownership enforcement for this data lives entirely in the resolver layer above it, not in the query function itself.

## Data & API Design

### 1. Domain model

No new entities. This feature is a read and a write over the already-modeled `Vehicle` / `TelemetrySnapshot` (schema documented in `docs/vehicle-telemetry-polling/tech-spec.md`):

- **Read**: `Vehicle.latestSnapshot` — the current dashboard snapshot for a vehicle.
- **Write**: `refreshVehicle` mutation — forces an on-demand Tesla Fleet API poll (bypassing the background poller's cadence), persists the result as a new `telemetry_snapshots` row via the existing `insertSnapshot`, and returns it.

No schema changes; both operate on the existing table.

### 2. API design

#### GraphQL schema surface

```graphql
type Vehicle {
  id: ID!
  vin: String!
  displayName: String
  model: String
  latestSnapshot: TelemetrySnapshot   # null if vehicle has no snapshots yet
  # ...
}

type Mutation {
  refreshVehicle(id: ID!): TelemetrySnapshot!
  # ...
}
```

`refreshVehicle(id: ID!)` takes a `Vehicle.id` (the internal vehicle row id, not the Tesla vehicle id). Return type is non-nullable `TelemetrySnapshot!` — the resolver either returns a snapshot or throws.

#### `refreshVehicle` error cases

Resolved in this order (`backend/src/graphql/resolvers/mutation.js`):

| Order | Condition | Code | Message |
|---|---|---|---|
| 1 | `ctx.isDemo` true | `FORBIDDEN` | `Not available in demo mode` |
| 2 | Not authenticated (via `requireOwnedVehicle` → `requireUser`) | `UNAUTHENTICATED` | `Not authenticated` |
| 3 | Vehicle doesn't exist, or exists but `vehicle.userId !== user.id` (both collapse to the same code so ownership isn't leaked) | `NOT_FOUND` | `Vehicle not found` |
| 4 | Last successful call to this resolver for this vehicle was < 60s ago | `RATE_LIMITED` | `Refresh rate-limited, try again shortly` |
| 5 | Vehicle was asleep and stayed asleep after wake + 5 poll attempts (3s apart) | `VEHICLE_UNREACHABLE` | `Vehicle did not wake up in time` |

Notes for the implementer, not restating architecture doc:
- The rate-limit check (step 4) runs *after* ownership is confirmed (step 3), and the timestamp is written to the in-memory `Map` immediately once the check passes — before any Tesla API call — so a slow wake/poll sequence can't be used to bypass the 60s window with concurrent requests.
- Steps 1–4 are synchronous/DB-only; only step 5 (and beyond) touches the Tesla Fleet API and can be slow (up to ~15s: 5 attempts × 3s, plus the wake call and poll latency itself).
- No explicit error case exists for a Tesla API failure downstream of the wake loop (e.g. `getVehicleState` rejecting) — it propagates as an unhandled rejection / generic `INTERNAL_SERVER_ERROR`, not a mapped code. Documented as-is; not a gap to silently fix here.

#### Frontend query/mutation documents

`frontend/src/graphql/queries/vehicle.js` — both share the same `SnapshotFields` fragment (all 17 `TelemetrySnapshot` scalar/JSON fields: `ts, state, batteryLevel, batteryRange, speed, lat, lng, heading, odometer, softwareVersion, locked, climateOn, insideTemp, outsideTemp, doorState, windowState, tirePressure`).

```graphql
query VehicleOverview($id: ID!) {
  vehicle(id: $id) {
    id
    vin
    displayName
    model
    latestSnapshot { ...SnapshotFields }
  }
}

mutation RefreshVehicle($id: ID!) {
  refreshVehicle(id: $id) { ...SnapshotFields }
}
```

`VEHICLE_OVERVIEW_QUERY` selects no `trips`/`chargingSessions`/`stateLog` fields — the overview page's map/stats/selector are built from `latestSnapshot` plus the four static vehicle fields only.

### 3. `getLatestSnapshot` function

`backend/src/db/queries/telemetry.js`

```js
export async function getLatestSnapshot(db, vehicleId)
```

- **Params**: `db` (pool/client), `vehicleId` (internal vehicle id, matches `telemetry_snapshots.vehicle_id`).
- **Returns**: a row shaped as `TelemetrySnapshot` (camelCase-aliased via `SELECT_FIELDS`), or `null` if the vehicle has no snapshots.

**Query 1** — newest row unconditionally:
```sql
SELECT <SELECT_FIELDS> FROM telemetry_snapshots
WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1
```
If no rows, return `null`. If `latest.odometer` is non-null, return `latest` as-is (no second query).

**Query 2** — only runs when `latest.odometer == null` (bare state-transition row, e.g. going asleep, with no telemetry payload):
```sql
SELECT <SELECT_FIELDS> FROM telemetry_snapshots
WHERE vehicle_id = $1 AND odometer IS NOT NULL ORDER BY ts DESC LIMIT 1
```

**Splicing logic**: if query 2 returns a row (`fallback`), the function returns `{ ...fallback, state: latest.state, ts: latest.ts }` — i.e. every field comes from the last row that actually had telemetry, *except* `state` and `ts`, which are overwritten with the newest row's values so the UI reflects current status (e.g. "Asleep") against a stale odometer/battery/etc. reading. If query 2 returns no rows (vehicle has only ever produced bare state rows), the original `latest` (with null odometer and all other telemetry fields null) is returned unchanged.

**Files consulted** (read-only, not modified): `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/{types,mutation,helpers}.js`, `backend/src/db/queries/telemetry.js`, `frontend/src/graphql/queries/vehicle.js`, `frontend/src/components/VehicleSelector.jsx`, `frontend/src/utils/section.js`.
