# Dashboard Overview

Per-vehicle landing page (`/v/:vehicleId/overview`): latest telemetry snapshot as stat tiles + map, a manual "Refresh Now" action, and a vehicle switcher shared across all vehicle-scoped pages.

Source of truth: `frontend/src/pages/OverviewPage.jsx`, `frontend/src/components/VehicleSelector.jsx`, `frontend/src/graphql/queries/vehicle.js`, `backend/src/graphql/resolvers/mutation.js` (`refreshVehicle`), `backend/src/graphql/resolvers/types.js` (`Vehicle.latestSnapshot`), `backend/src/db/queries/telemetry.js` (`getLatestSnapshot`).

## Page

`VEHICLE_OVERVIEW_QUERY` fetches `vehicle { id vin displayName model latestSnapshot { ...SnapshotFields } }`. `latestSnapshot` is `null` if the vehicle has never produced a telemetry row — the page then shows "No telemetry yet." instead of stat cards/map (header and Refresh button still render).

- Battery/Range/Odometer cards each independently render `—` when their field is `null`.
- Locked renders `Yes` only when `locked` is strictly truthy — `false`, `null`, and `undefined` all render `No`. There's no "unknown" state in the UI.
- Map (single marker, popup text `Last seen {new Date(snap.ts).toLocaleString()}`) renders only when both `lat` and `lng` are non-null on the snapshot.

## `refreshVehicle(id: ID!): TelemetrySnapshot!`

Forces an on-demand Tesla Fleet API poll for one vehicle, bypassing the worker's normal adaptive cadence (see `docs/vehicle-telemetry-polling.md`). Not instant — see timing below. On success the frontend doesn't use the mutation's return value directly; `onCompleted` calls `refetch()` on the overview query instead.

### Error codes

Checked in this order in `backend/src/graphql/resolvers/mutation.js`; the first condition that applies throws and stops the rest:

| Order | Code | Message | Condition |
|---|---|---|---|
| 1 | `FORBIDDEN` | "Not available in demo mode" | `ctx.isDemo` |
| 2 | `UNAUTHENTICATED` | "Not authenticated" | no session (`requireOwnedVehicle` → `requireUser`) |
| 3 | `NOT_FOUND` | "Vehicle not found" | vehicle doesn't exist, or exists but isn't owned by the caller — both collapse to the same code so ownership isn't leaked |
| 4 | `RATE_LIMITED` | "Refresh rate-limited, try again shortly" | last successful call for this vehicle was < 60s ago |
| 5 | `VEHICLE_UNREACHABLE` | "Vehicle is \{state\} and did not wake up in time" | `getVehicleLite` never reported `online`, even after wake + 5 poll attempts |
| 6 | `VEHICLE_UNREACHABLE` | "Vehicle reported online but its data channel didn't respond in time, even after a second wake attempt. ..." | `getVehicleLite` said `online`, but `getVehicleState` (the actual `vehicle_data` call) got HTTP 408 from Tesla — see below — and a second wake-and-wait + retry also 408'd |

Anything Tesla's API itself rejects with that isn't one of the above (a non-408 error from `getVehicleState`, or a 408 that a retry actually recovers from) isn't mapped to a code — it either propagates as a generic/unhandled error, or the request simply succeeds on retry.

### The `online`-but-408 gap (why there's a second wake attempt)

`getVehicleLite` (the `/vehicles/{id}` list endpoint) reports `online` as soon as the car's networking wakes up — which can be seconds before its actual data channel is ready to answer `vehicle_data`. In that gap, `tesla.getVehicleState` gets back **HTTP 408** from Tesla, which per Tesla's Fleet API docs means "vehicle unavailable," not a real request timeout. This is exactly the case a user hits pressing "Refresh Now" on an idle-but-recently-active vehicle.

`packages/tesla-client/src/client.js`'s `call()` attaches the numeric status to the thrown `Error` (`err.status`) so the resolver can special-case this. `refreshVehicle` catches a 408 from `getVehicleState` specifically (any other status propagates immediately, unhandled — a 401/rate-limit/etc. isn't this case and shouldn't trigger a pointless wake), sends one more `wakeVehicle` + the same 5×3s poll-for-`online` loop (factored out as `wakeAndWaitForOnline`, shared with the pre-flight check above), then retries `getVehicleState` exactly once. A second 408 throws error code 6 above with the full explanation, matching what pressing the equivalent button in Tesla's own app does — that app's wake action (e.g. flashing the lights) reliably brings the data channel up because it's a stronger nudge than this endpoint's `wake_up` call, which is why the error message suggests it as a fallback.

### Timing: wake-and-wait is synchronous, up to ~15s (~45s worst case on a 408)

If the lightweight status check (`getVehicleLite`, never wakes the car) reports anything other than `online`, the resolver sends a wake command and re-checks up to 5 times, 3 seconds apart, before either proceeding to the full poll or throwing `VEHICLE_UNREACHABLE` (error 5). The GraphQL request stays open for the whole loop — there is no "202 + poll a status query" protocol on the client. If `getVehicleLite` already said `online` but `getVehicleState` then 408s, the same ~15s wake-and-wait runs a second time before one retry, so the worst case (initial wake-and-wait + 408 + second wake-and-wait) is close to 45 seconds, not 15. The frontend's only handling of this wait is disabling the button and showing "Refreshing…" for the duration; there's no separate "waking up" message, and no visual difference between the ~15s and ~45s cases.

### Rate limit: 60s per vehicle, in-memory

`lastRefreshAt` is a process-local `Map<vehicleId, timestamp>` in `mutation.js` — not persisted to the DB, so it resets on every backend restart/deploy. It throttles *the vehicle* (keyed on internal `vehicle.id`), not the calling user or IP — don't rely on it as an anti-abuse control. The timestamp is written immediately after the rate-limit check passes, before any Tesla API call, so a slow in-flight wake-and-wait can't be used to sneak a second request through inside the same 60s window.

## `Vehicle.latestSnapshot` / `getLatestSnapshot` — sleep-fallback quirk

`getLatestSnapshot(db, vehicleId)` is what both the overview query's `latestSnapshot` field and `refreshVehicle`'s return value resolve through.

1. Fetch the single newest `telemetry_snapshots` row for the vehicle (`ORDER BY ts DESC LIMIT 1`).
2. If it has a non-null `odometer`, return it as-is — no second query.
3. If `odometer` is `null` (a bare state-transition row, e.g. the worker recording "went asleep" with no telemetry payload), fetch the newest row with `odometer IS NOT NULL`, and return that row with `state` and `ts` overwritten by the newer bare row's values. If no such row exists at all, return the bare row unchanged (every field but `state`/`ts` is null).

**Consequence for anyone consuming this field:** `state` and `ts` can be newer than every other field on the same object. A vehicle can show a fresh "asleep" chip next to a battery/odometer/location reading that's actually from whenever it was last awake — that's this fallback working as designed, not stale/corrupt data. Nothing besides `state`/`ts` is backfilled per-field; it's a single whole-row substitution, one hop deep (it won't walk further back if the fallback row is itself incomplete).

`getLatestSnapshot` trusts `vehicleId` as passed in and applies no ownership filter of its own — safe today only because its two callers (`Vehicle.latestSnapshot`, the tail of `refreshVehicle`) both sit behind resolvers that already ran `requireOwnedVehicle`.

## Vehicle selector

`VehicleSelector` renders whenever the user has one or more linked vehicles (including exactly one — it's not gated on "more than one"). On change it navigates to `/v/{newVehicleId}/{currentSection}`, preserving whatever tab the user is on via `sectionFromPath(location.pathname)` (`frontend/src/utils/section.js`: `pathname.split("/")[3] || "overview"`).
