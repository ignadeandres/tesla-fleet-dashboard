# Implementation Notes — Dashboard Overview

**Feature:** Per-vehicle Overview page (landing page) + Vehicle Selector
**Status:** Implemented and shipped. See `docs/dashboard-overview/tech-spec.md` for the full architecture/data/API reference (ADRs, error table, schema) — this document summarizes what's actually in the code and what verification exists.

## Summary

The Overview page is the per-vehicle landing page at `/v/:vehicleId/overview`. It shows the vehicle's latest telemetry snapshot as four stat tiles (battery %, range, odometer, locked) plus a Leaflet map pin for the last known location, a status chip (e.g. "driving"/"asleep"), and a manual "Refresh Now" button that forces an on-demand Tesla Fleet API poll. A `VehicleSelector` dropdown elsewhere in the shell lets the user switch vehicles while staying on the same section (trips/charging/overview/etc.).

No new backend entities or schema — this feature is entirely a read (`Vehicle.latestSnapshot`) and a write (`refreshVehicle` mutation) over the already-modeled `Vehicle` / `TelemetrySnapshot` tables from the `vehicle-telemetry-polling` feature.

## Key files and their role

- **`frontend/src/pages/OverviewPage.jsx`** — the page itself. Runs `VEHICLE_OVERVIEW_QUERY` via `useQuery`, renders stat tiles/map from `vehicle.latestSnapshot`, and wires the refresh button to `REFRESH_VEHICLE_MUTATION` via `useMutation` with `onCompleted: () => refetch()`. The refresh button is hidden entirely for demo users (`!auth.user?.isDemo`) rather than shown-and-disabled, matching the backend's `FORBIDDEN` in demo mode. Mutation errors are swallowed in `onError` (no-op) specifically so they surface once via the `error` object rendered as an `Alert`, rather than also throwing an unhandled promise rejection.
- **`frontend/src/components/VehicleSelector.jsx`** — a MUI `Select` of the user's vehicles. On change it navigates to `/v/{newVehicleId}/{currentSection}`, reusing `sectionFromPath` from `frontend/src/utils/section.js` (already-established utility, not new code for this feature) to preserve whatever section the user was on.
- **`frontend/src/graphql/queries/vehicle.js`** — defines `SnapshotFields` (shared fragment, all 15 `TelemetrySnapshot` fields), `VEHICLE_OVERVIEW_QUERY`, and `REFRESH_VEHICLE_MUTATION`. The overview query intentionally selects only `id, vin, displayName, model, latestSnapshot` — no `trips`/`chargingSessions`/`stateLog` — keeping the landing-page query cheap.
- **`backend/src/graphql/resolvers/mutation.js`** (`refreshVehicle`) — validates in order: not-demo → `requireOwnedVehicle` (ownership, throws `NOT_FOUND` without leaking existence) → in-memory 60s rate limit (`RATE_LIMITED`) → wake-and-wait loop if asleep (5× 3s poll, `VEHICLE_UNREACHABLE` on timeout) → full state fetch → `insertSnapshot` → returns `getLatestSnapshot`. The rate-limit timestamp (`lastRefreshAt` Map, keyed by internal vehicle id) is written *before* any Tesla API call, so concurrent slow requests can't bypass the window.
- **`backend/src/graphql/resolvers/types.js`** (`Vehicle.latestSnapshot`) — a one-line resolver delegating straight to `getLatestSnapshot(ctx.db, vehicle.id)`. No ownership check here — it relies entirely on the resolver chain above it (`vehicle(id)` query resolver) having already scoped access.
- **`backend/src/db/queries/telemetry.js`** (`getLatestSnapshot`) — two-query shape: newest row unconditionally, then (only if that row's `odometer IS NULL`, i.e. a bare state-transition row like "went asleep") a second query for the newest row with actual telemetry, splicing `state`/`ts` from the first row onto the rest of the second. No ownership filter of its own — trusts the caller.

## Notable implementation decisions / gotchas found while reading

- **Frontend refresh error handling is a two-step dance**: `onError: () => {}` on the mutation options is required to prevent Apollo from throwing an unhandled rejection when `refreshVehicle()` is called without a `.catch()`, but the actual error display comes from the `error` field destructured off `useMutation`. Missing either half breaks the UX differently (unhandled rejection vs. no error shown) — this isn't obvious from the JSX alone without knowing Apollo's `useMutation` error-propagation behavior.
- **`getLatestSnapshot`'s fallback only patches `state`/`ts`, not per-field** — if the vehicle goes asleep, the UI will show a fresh "Asleep" chip next to a *stale* battery/odometer/location reading from whenever it was last awake. This is documented as accepted behavior in the tech-spec (Story 4), not a bug, but is easy to mistake for one when eyeballing the Map/Stat tiles showing an old position under a current "Asleep" label.
- **`refreshVehicle` ownership check runs once, before the ~15s wake loop**, not re-checked mid-loop. Correct today only because vehicles aren't transferable between users mid-request — worth knowing before that assumption changes.
- **The rate limiter throttles the vehicle, not the caller** (keyed on internal `vehicle.id`, in-memory `Map`, resets on backend restart). It is not an anti-abuse control on the user/IP — a restart lets one extra manual click through sooner than 60s, accepted as low-risk per the tech-spec.
- **`VehicleSelector` has no loading/empty state of its own** — it's handed `vehicles` as a prop and assumes it's populated by the time it renders; there's no guard against an empty array (renders an empty `Select`) since callers apparently only mount it once the vehicle list has loaded.
- **`OverviewPage` has no snapshot-polling/subscription** — after the initial `useQuery`, the only way the displayed data changes is a manual "Refresh Now" click (`refetch()`) or a full page reload; it does not pick up new snapshots the background worker inserts on its own cadence without user action.

## Verification

**Backend:** `backend/package.json`'s `test` script is `node --test $(find src -name '*.test.js')`. Ran it — all pass:

```
✔ signToken/verifyToken roundtrip returns the original user id
✔ verifyToken rejects a token signed with a different secret
✔ verifyToken rejects an expired token
✔ returns the latest row as-is when it already has telemetry
✔ falls back to the last real reading when the latest row is a bare asleep marker, keeping the fresh state/ts
✔ returns the bare asleep row when there's no prior reading at all
✔ returns null when there's no snapshot yet
✔ requireOwnedVehicle returns the vehicle when the requester owns it
✔ requireOwnedVehicle throws NOT_FOUND for another user's vehicle
✔ requireOwnedVehicle throws UNAUTHENTICATED with no user in context
✔ efficiencyKmPerPercent divides distance by battery % consumed
✔ efficiencyKmPerPercent returns null when battery levels are missing
✔ efficiencyKmPerPercent returns null when net usage isn't positive

tests 13, pass 13, fail 0
```

**Covered for this feature specifically:**
- `backend/src/db/queries/telemetry.test.js` — `getLatestSnapshot`'s core logic: pass-through when telemetry present, fallback splice when the latest row is a bare state marker, no-fallback-available case, and empty-table → `null`. This is the feature's only non-trivial branch/logic path, and it's the one file with direct, thorough unit coverage.
- `backend/src/graphql/resolvers/helpers.test.js` — `requireOwnedVehicle`'s three outcomes (owned, other user's vehicle, unauthenticated). Used by `refreshVehicle` but tested generically, not through the mutation itself.

**Not covered (no test files exist for these):**
- `backend/src/graphql/resolvers/mutation.js` — no `mutation.test.js`. The `refreshVehicle` resolver's own logic (rate-limit timing/ordering, the wake-and-wait retry loop, `VEHICLE_UNREACHABLE` after 5 failed attempts, the `driving`/`charging`/`online` state derivation from `drive_state`/`charge_state`) has zero automated test coverage — it's only exercised indirectly via `getLatestSnapshot` and `requireOwnedVehicle` being unit-tested in isolation. This is the highest-value gap: it's the one piece of money/reliability-adjacent branching logic in the feature (rate limiting, retry timing, state derivation) with no runnable check.
- `backend/src/graphql/resolvers/types.js` — `Vehicle.latestSnapshot` itself isn't tested (it's a one-line passthrough, so low risk).
- **Frontend has no test runner at all** — `frontend/package.json`'s `scripts` block has no `test` entry, and no `*.test.*`/`*.spec.*` files exist anywhere under `frontend/`. `OverviewPage.jsx` and `VehicleSelector.jsx` (including the error-swallowing/`Alert` display logic, the demo-mode button hiding, and the section-preserving navigation) have no automated coverage of any kind — no component tests, no E2E. This mirrors the project-wide state (no frontend tests exist for any feature, not something specific to this one), so it isn't a dashboard-overview-specific regression, but it is a real gap for this feature's more UI-logic-bearing pieces (error surfacing, demo-mode gating).

Per the task instructions, no new tests were written — this section reports what exists and runs, not what was added.
