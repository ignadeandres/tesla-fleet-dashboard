# Functional Spec — Dashboard Overview

**Feature:** Per-vehicle Overview page (landing page) + Vehicle Selector
**Status:** Already implemented and shipped. Elaborates `docs/dashboard-overview/business-requirements.md`.

## Functional Behavior

Source of truth for all flows below: `frontend/src/pages/OverviewPage.jsx`, `frontend/src/components/VehicleSelector.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/graphql/queries/vehicle.js`, `backend/src/graphql/resolvers/query.js`, `backend/src/graphql/resolvers/mutation.js`, `backend/src/graphql/resolvers/helpers.js`, `backend/src/graphql/resolvers/types.js`, `backend/src/db/queries/telemetry.js`.

### 1. Page load flow (Story 1)

**Flow**
1. User navigates to `/v/{vehicleId}/overview` (route param `vehicleId`).
2. Page fires `VEHICLE_OVERVIEW_QUERY` for that `vehicleId`, requesting `id, vin, displayName, model, latestSnapshot { ...all 17 TelemetrySnapshot fields }`.
3. Backend resolves `Query.vehicle(id)` → `requireOwnedVehicle(ctx, id)`, which loads the vehicle and checks `vehicle.userId === ctx.user.id`.
4. If owned, `Vehicle.latestSnapshot` resolver runs `getLatestSnapshot(db, vehicleId)` (see Story 4 for its fallback logic) and returns either a snapshot object or `null`.
5. Frontend renders based on `loading` / `data` / `data.vehicle.latestSnapshot` (see System States below).

**Business rules**
- Vehicle name: `displayName` if set and non-empty, else `vin`. No further fallback (no "Unknown vehicle" placeholder is rendered — if both are empty the heading is blank).
- State chip: rendered only when `latestSnapshot.state` is non-null/non-empty; absent entirely otherwise (not rendered as an empty or "Unknown" chip).
- Battery card: `{batteryLevel}%` when `batteryLevel != null`, else `—`.
- Range card: `{Math.round(batteryRange)} km` when `batteryRange != null`, else `—`. Rounding uses standard round-half-up (`Math.round`); no unit conversion is applied (source values are assumed already km).
- Odometer card: `{Math.round(odometer)} km` when `odometer != null`, else `—`.
- Locked card: `Yes` only when `locked` is strictly truthy; **every other value — `false`, `null`, `undefined` — renders `No`**. This is a single equality check (`snap.locked ? "Yes" : "No"`), not a three-state check; there is no way for the UI to distinguish "confirmed unlocked" from "lock state unknown." *(Assumption, per business doc: not confirmed as intentional.)*
- No-snapshot case: when `latestSnapshot` is `null` (vehicle has zero telemetry rows ever, or is unreachable at the resolver level), neither the stat-card grid nor the map is rendered; the text "No telemetry yet." is shown in their place. The page header (name, state chip, Refresh button) still renders normally in this case.

**System states**
| State | Trigger | Rendered result |
|---|---|---|
| Loading (cold) | `loading === true` AND `data` not yet populated (first load, no cache) | Spinner only; nothing else on the page renders |
| Loading (background refetch) | `loading === true` but `data` already populated (e.g. refetch after mutation, Apollo cache hit) | Previous data stays on screen; no spinner shown (loading flag is ignored once `data` exists) |
| Empty | `data.vehicle.latestSnapshot === null` | Header renders; "No telemetry yet." shown; no cards, no map |
| Success | `latestSnapshot` present | Header, optional state chip, 4 stat cards, map (if lat/lng present) all render |
| Query error (vehicle not found / not owned) | `Query.vehicle` throws `NOT_FOUND` (e.g. bad/foreign `vehicleId` in URL) | **Not explicitly handled** — the page destructures only `{ data, loading, refetch }` from `useQuery`, not `error`. On a GraphQL error, `data` stays `undefined`, so `vehicle` and `snap` are both `undefined`, and the page falls into the same rendering path as the Empty state: header shows blank name, no state chip, "No telemetry yet." text. *(Flagging: this is observed shipped behavior — a nonexistent/foreign vehicle ID currently looks identical to "my vehicle has no telemetry yet" rather than showing a distinct error. Not raising as a defect to fix here, only documenting actual behavior.)*

### 2. Map with last known location (Story 2)

**Flow**
1. Once `latestSnapshot` is non-null, check `snap.lat != null && snap.lng != null`.
2. If both present, render the shared `Map` component (see `docs/trips/` for internals) centered on `[lat, lng]`, with one `Marker` at `[lat, lng]`.
3. Clicking/tapping the marker opens a `Popup` showing `"Last seen {new Date(snap.ts).toLocaleString()}"`.

**Business rules**
- Both coordinates must be non-null; a snapshot with only one of `lat`/`lng` set is treated as "no location" (no partial map, no error message — the map section is simply omitted).
- Stat cards do not depend on location — they render regardless of whether the map renders, as long as `latestSnapshot` itself is non-null.
- Timestamp formatting is entirely client-locale-driven (`Date.prototype.toLocaleString()`); no fixed format, no timezone label, no relative ("2 hours ago") phrasing. *(Assumption, per business doc: current behavior, not a stated requirement.)*
- The popup is the only place a timestamp/staleness indicator appears anywhere on the page — the stat cards themselves carry no "as of" label, so a card can silently reflect hours-old data with no visual cue.

**System states**
| State | Trigger | Rendered result |
|---|---|---|
| Location available | `lat` and `lng` both non-null | Map + marker rendered; popup available on click |
| Location unavailable | `lat` or `lng` null (or `latestSnapshot` itself null) | No map section at all — not a placeholder, not an error, just absent |

### 3. Manual refresh (Story 3)

**Flow**
1. Header conditionally renders a "Refresh Now" `Button` when `!auth.user?.isDemo`. Demo users never see the button (client-side gating; see `docs/demo-mode/` for rationale — server also independently rejects, see rule below).
2. Click → `refreshVehicle({ id: vehicleId })` mutation fires. Apollo's `loading` (`refreshing`) flips to `true` immediately.
3. While in flight: button `disabled`, label changes from `"Refresh Now"` to `"Refreshing…"`.
4. **Backend processing (grounds what errors can surface in step 6):**
   a. Server independently checks `ctx.isDemo` and throws `FORBIDDEN` ("Not available in demo mode") even if a client somehow bypassed the UI gate.
   b. Ownership re-checked via `requireOwnedVehicle` (`NOT_FOUND` if not owned).
   c. **Rate limit:** per-vehicle in-memory timestamp map; a second refresh within 60 seconds of the last one throws `RATE_LIMITED` ("Refresh rate-limited, try again shortly"). Limit is per `vehicle.id`, process-local (not persisted — resets on server restart).
   d. Server fetches a lightweight vehicle status (`getVehicleLite`). If Tesla reports the car `asleep`, the server sends a wake command and polls up to 5 times at 3-second intervals (≈15s worst case) waiting for it to leave the asleep state.
   e. If still asleep after 5 attempts, throws `VEHICLE_UNREACHABLE` ("Vehicle did not wake up in time").
   f. Otherwise fetches full vehicle state, derives `state` as `"driving"` (shift state D/R/N or speed > 0) → `"charging"` (charging_state === "Charging") → else `"online"`, inserts a new telemetry snapshot row with that state and current timestamp, and returns the freshly recomputed `latestSnapshot` (via the same `getLatestSnapshot` fallback logic as Story 4).
5. On mutation success (`onCompleted`): the Overview query is refetched (`refetch()`), so the page re-renders with the new snapshot. The mutation's own return value is not used directly to update the UI — the subsequent `refetch` is the source of the displayed data.
6. On mutation failure (`onError: () => {}` — deliberately swallowed at the mutation-hook level so it becomes a rejected-but-caught state rather than an unhandled promise rejection): the hook's `error` object is read separately and, if present, rendered as an MUI `Alert` (`severity="error"`) above the stat-card grid, containing `error.message` verbatim (e.g. "Refresh rate-limited, try again shortly", "Vehicle did not wake up in time", "Not available in demo mode").

**Business rules**
- Button visibility is purely `isDemo`-driven; there is no separate check for "do I have a vehicle" or "is a snapshot present" — the button shows even when `latestSnapshot` is null (i.e. it's usable to fetch the first-ever snapshot).
- Only one rate-limit window is tracked per vehicle server-side; rapid repeated clicks are further prevented client-side by the `disabled` state during the in-flight request, but the 60s server-side limit is the actual guard against back-to-back successful clicks (disable state only prevents overlapping in-flight requests, not clicks spaced seconds apart after one completes).
- A failed refresh does not clear or roll back any currently-displayed data — the last successfully loaded snapshot (if any) remains on screen underneath the error Alert.
- Error Alert has no dismiss/close affordance in the current implementation — it persists until the next mutation attempt changes `refreshError`'s value (i.e. a subsequent click either clears it on success or replaces it with a new error).

**System states**
| State | Trigger | Rendered result |
|---|---|---|
| Idle | No mutation in flight, no prior error | Button enabled, label "Refresh Now" (non-demo only) |
| In flight | Mutation pending | Button disabled, label "Refreshing…"; existing page content unchanged |
| Success | Mutation resolves without error | Query refetches; button returns to idle; page shows updated stats/state/map from new snapshot |
| Error | Mutation rejects (`FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `VEHICLE_UNREACHABLE`, or any other thrown error) | `Alert` with `error.message` shown above stat cards; button returns to idle/enabled; existing (stale) data remains displayed |
| Demo user | `auth.user.isDemo === true` | Button not rendered; refresh is unreachable from this page's UI entirely |

### 4. Sleep-state fallback — `getLatestSnapshot` (Story 4)

**Flow**
1. Query the single most recent telemetry row for the vehicle (`ORDER BY ts DESC LIMIT 1`).
2. If no row exists → return `null` (feeds the Empty state in Story 1).
3. If the row exists and `odometer` is non-null → return it as-is; no further query.
4. If the row exists but `odometer IS NULL` (a bare state-transition row, e.g. a sleep event that carries no telemetry payload) → run a second query for the most recent row where `odometer IS NOT NULL`.
   - If a fallback row is found: return that row's full telemetry payload, but with `state` and `ts` overridden to the newer bare row's values (so the UI shows the current/fresher state and timestamp, backed by the last real reading for everything else — battery, location, lock status, etc.).
   - If no fallback row exists at all (i.e. every row for this vehicle has a null odometer, or the bare row is the only row) → return the bare row itself, unmodified (all telemetry fields on it will be null/absent, which then drives the "—" placeholders in Story 1's stat cards).

**Business rules**
- This fallback only ever substitutes `state` + `ts`; it never merges or backfills any other field between the two rows (e.g. it will not pull a newer `state` alongside an older `lat`/`lng` and then also try to guess a newer battery level — everything besides `state`/`ts` comes from the single fallback row).
- The fallback is one hop deep — it does not walk further back if the fallback row is itself somehow incomplete; whatever the second query returns (or doesn't) is final.
- This logic is entirely server-side and runs on every `latestSnapshot` resolution — both the initial Overview page load and the snapshot returned at the end of a successful `refreshVehicle` mutation go through it.

**System states** (these map directly onto Story 1's states, listed here for traceability)
| Backend condition | `latestSnapshot` result | Downstream UI effect |
|---|---|---|
| No rows | `null` | Empty state ("No telemetry yet.") |
| Latest row has odometer | that row | Full success state |
| Latest row lacks odometer, older row with odometer exists | older row's telemetry + newer row's `state`/`ts` | Success state; state chip shows current state (e.g. "asleep") even though numeric stats are from an earlier reading |
| Latest row lacks odometer, no row anywhere ever has odometer | the bare row, mostly null fields | Success-path rendering, but every stat card except (possibly) `locked`/`state` shows "—" |

### 5. Vehicle selector (Story 5)

**Flow**
1. `Layout` reads `auth.user.vehicles` (array, possibly empty).
2. If `vehicles.length > 0`, render `VehicleSelector` in the app header (rendered on every vehicle-scoped page, not just Overview — it's in the shared `Layout`, above the per-section `Outlet`).
3. Selector is a dropdown listing each vehicle's `displayName` (fallback `vin`), keyed by `vehicle.id`.
4. Current value is read from the route's `vehicleId` param, so the selector always reflects the vehicle currently being viewed.
5. On selection change: compute the current section from the URL via `sectionFromPath(location.pathname)` (path segment at index 3, e.g. `/v/abc/trips` → `"trips"`; defaults to `"overview"` if that segment is missing), then navigate to `/v/{newVehicleId}/{section}`.

**Business rules**
- Rendering condition is `vehicles.length > 0`, i.e. **one or more**, not "more than one" — a single-vehicle account still sees a (single-item) dropdown. *(Open question, per business doc: not confirmed whether intended for multi-vehicle-only display.)*
- Section preservation is done purely by string-matching the current path's 4th segment; it does not validate that the target section is meaningful for the new vehicle (e.g. there is no per-vehicle check of "does this section exist/apply" — the navigation is unconditional).
- Zero vehicles → selector is entirely absent (not disabled, not shown-empty) — no dropdown affordance exists to reach a vehicle at all from this control.

**System states**
| State | Trigger | Rendered result |
|---|---|---|
| ≥1 vehicle | `vehicles.length > 0` | Dropdown shown, current vehicle pre-selected |
| 0 vehicles | `vehicles.length === 0` | No selector rendered (behavior for the rest of the page in this case is out of scope — not exercised by current UI) |
| Selection changed | `onChange` fires with different vehicle id | Immediate client-side navigation to same section, new vehicle id; triggers a fresh Overview query load per Section 1's flow |

## User Flow

### 1. First landing after login (telemetry present)

- **Entry point:** `HomeRedirect` (`frontend/src/App.jsx:13-17`) fires on `/` for any authenticated user with `auth.user.vehicles[0]` set → `navigate("/v/{firstVehicleId}/overview", { replace: true })`. This is the default landing screen referenced in `docs/authentication/functional-spec.md` flows 1 and 2 ("Has ≥1 linked vehicle → redirected straight to `/v/{firstVehicleId}/overview`").
- Route resolves to `Layout` (persistent chrome: app bar, vehicle selector, section tabs) wrapping `OverviewPage` via `<Outlet />`.
- `OverviewPage` mounts, `VEHICLE_OVERVIEW_QUERY` fires for `vehicleId` from `useParams()`. While `loading && !data`, the page body is a bare `CircularProgress` (`OverviewPage.jsx:30`) — no skeleton, no chrome-level loading state; app bar/tabs are already rendered by `Layout` since `vehicleId` is present.
- Query resolves with `vehicle.latestSnapshot` populated (`snap`) → page renders:
  - Header row: vehicle `displayName` (fallback to `vin`), a state `Chip` (only if `snap.state` is set), spacer, and the "Refresh Now" `Button` (only if `!auth.user.isDemo`).
  - 4-card stat grid: Battery, Range, Odometer, Locked — each field independently falls back to `"—"` if `null`, so a partial snapshot (e.g., no odometer yet) doesn't blank the whole card.
  - `Map` with a single `Marker` at `[snap.lat, snap.lng]` and a `Popup` showing `"Last seen {snap.ts as locale string}"` — rendered only when `snap.lat != null && snap.lng != null`.
- **Exit points:** section `Tabs` in `Layout` (Trips/Charging/Trends/State Log, same vehicle), the `VehicleSelector` dropdown (see flow 5), or "Log out."

### 2. First landing with zero telemetry

- Same entry as flow 1 — `HomeRedirect` → `/v/{id}/overview`. Divergence happens after the query resolves: `vehicle.latestSnapshot` is `null`/`undefined`.
- `OverviewPage.jsx:53-54`: the stat grid and map are skipped entirely; a single `Typography color="text.secondary"` reads `"No telemetry yet."` in place of the whole body.
- The header row (vehicle name, Refresh Now button) still renders normally above this message — refreshing is the expected recovery action from this state, not a route change.
- No distinct exit points beyond flow 1 (tabs, selector, logout) plus a successful manual refresh transitioning into flow 3's success path (snapshot now populated, grid/map appear in place without navigation).

### 3. Manual refresh — success

- **Entry point:** "Refresh Now" button, visible only for non-demo users, on the Overview screen (any telemetry state).
- Click → `refreshVehicle()` mutation fires with `variables: { id: vehicleId }`. Button immediately reflects the in-flight mutation: `disabled={refreshing}`, label swaps to `"Refreshing…"` (`OverviewPage.jsx:41-43`). No full-page loading indicator — only the button changes state; existing cards/map stay visible and unchanged during the request.
- On success, `onCompleted` calls `refetch()` on `VEHICLE_OVERVIEW_QUERY` (`OverviewPage.jsx:26`). The button returns to enabled `"Refresh Now"` once `refreshing` clears; cards, chip, and map update in place with the newly fetched snapshot — no navigation, no page remount, no toast/confirmation.
- **Exit point:** none distinct — user remains on Overview with refreshed data; free to trigger another refresh, switch tabs, or switch vehicles.

### 4. Manual refresh — failure

- Same entry as flow 3. The mutation's `onError` handler is a no-op by design (`onError: () => {}`, comment: "swallow here so it surfaces via `error` below instead of an unhandled rejection") — the failure surfaces through the mutation's `error` return value (`refreshError`), not a thrown/unhandled rejection.
- While the request is in flight, same `"Refreshing…"`/disabled state as flow 3. On failure, `refreshing` clears, button returns to enabled `"Refresh Now"` (user can retry immediately), and an `Alert severity="error"` renders above the stat cards/no-telemetry message showing `refreshError.message` (`OverviewPage.jsx:47-51`).
- The alert is not dismissible and has no explicit empty/cleared state wired — it persists until the next mutation attempt changes `refreshError` (a subsequent successful refresh clears it since `refreshError` comes fresh off the mutation hook each call).
- Underlying data is untouched by a failed refresh: whatever snapshot/cards/map were showing before the click remain exactly as they were (query is never refetched on error).
- **Exit point:** none distinct — user stays on Overview, alert visible, free to retry or navigate away (navigating away and back does not "remember" the error; it's local to the mutation hook's live state).

### 5. Switching vehicles via the header selector

- **Entry point:** `VehicleSelector` dropdown in `Layout`'s app bar, rendered whenever `vehicles.length > 0` (`Layout.jsx:30`) — present on every authenticated screen, not just Overview.
- Current vehicle is reflected via `value={vehicleId || ""}` bound to the route param, so the selector always shows the vehicle currently being viewed, no separate local state to desync.
- On selection, `handleChange` (`VehicleSelector.jsx:10-12`) navigates to `/v/{selectedVehicleId}/{sectionFromPath(location.pathname)}` — i.e., it preserves whatever section tab the user is currently on (Overview, Trips, Charging, Trends, State Log) and swaps only the vehicle segment. `sectionFromPath` reads the 4th path segment and defaults to `"overview"` if absent (`section.js:3-5`).
- This is a client-side route change: `Layout` persists (app bar, tabs, selector don't remount), only `Outlet`'s child page remounts for the new `vehicleId`, re-running its query from a loading state. On Overview specifically, that means the same `loading && !data` → `CircularProgress` beat as flow 1 replays for the new vehicle before its cards/map/no-telemetry state renders.
- **Exit point:** lands on the same section for the newly selected vehicle; if that vehicle's data diverges (e.g., zero telemetry vs. populated), the corresponding flow (1 or 2) plays out from there.

### 6. Demo user variant

- **Entry point:** same `HomeRedirect` → `/v/{id}/overview` as flow 1; demo accounts are seeded with at least one vehicle (per `docs/demo-mode/`), so they do not get diverted to `/vehicles`.
- Visual difference in `Layout`'s app bar: a `Chip label="Demo Mode"` appears next to the title (`Layout.jsx:29`), and "Link Tesla Account" is hidden (`!auth.user.isDemo` guard, `Layout.jsx:32`) — both `auth.user.isDemo` checks, same flag `OverviewPage` uses.
- On the Overview page itself: the entire "Refresh Now" button is omitted (`!auth.user?.isDemo` guard, `OverviewPage.jsx:40`) — not disabled, not present. Consequently flows 3 and 4 (manual refresh success/failure) are **unreachable** for demo users; there is no UI affordance to trigger `REFRESH_VEHICLE_MUTATION` on this screen. Stat cards, map, no-telemetry message, and vehicle-switching (flow 5) behave identically to a regular user — demo data is pre-seeded/static rather than pollable, which is why the trigger is withheld rather than rendered-and-disabled.
- **Exit points:** identical to flow 1 (tabs, vehicle selector, logout).

**Files consulted** (read-only, not modified): `frontend/src/pages/OverviewPage.jsx`, `frontend/src/components/VehicleSelector.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/App.jsx`, `frontend/src/utils/section.js`, `backend/src/graphql/resolvers/{query,mutation,helpers,types}.js`, `backend/src/db/queries/telemetry.js`, `docs/authentication/functional-spec.md`, `docs/demo-mode/functional-spec.md`.
