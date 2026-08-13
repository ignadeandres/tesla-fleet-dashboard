# Functional Spec — Battery Health Trends

**Feature:** User-facing "Trends" page — raw battery level (%) over time, not a degradation/health metric (see business-requirements naming-mismatch note)
**Status:** Already implemented and shipped. Elaborates `docs/battery-health-trends/business-requirements.md`.

## Functional Behavior

### Scope
Covers `/v/:vehicleId/trends`: fetching and rendering battery-level history for one vehicle, and reaching that page via the vehicle nav tabs. Grounded in `TrendsPage.jsx`, `BatteryTrendChart.jsx`, `Layout.jsx`, `stateLog.js` query, `types.js` resolver, `telemetry.js` (`getStateLog`).

### Story 1 — View battery level history

**Trigger:** user navigates to `/v/:vehicleId/trends` (directly, via back/forward, or via the Trends tab).

**Step-by-step flow**
1. `TrendsPage` reads `vehicleId` from the route and fires `VEHICLE_STATE_LOG_QUERY` with `{ id: vehicleId }`. `from`/`to` are declared in the query but never supplied — both resolve to `null`/undefined on the wire, so the server treats the range as unbounded.
2. Backend resolver `Vehicle.stateLog(from, to)` → `getStateLog(db, vehicleId, from, to)` runs:
   `SELECT ... WHERE vehicle_id = $1 AND ts BETWEEN COALESCE(from, -infinity) AND COALESCE(to, infinity) ORDER BY ts DESC LIMIT 2000`.
   With no `from`/`to`, this returns the **2000 most recent snapshots for the vehicle**, newest first.
3. Frontend receives the array (newest-first) and reverses it in place (`[...log].reverse()`) before handing it to the chart, so the chart consumes it **oldest-to-newest**.
4. Chart maps each row to a point: `tsLabel = toLocaleDateString(ts)` for the x-axis, `batteryLevel` for the y-axis value, and keeps raw `ts` on the point payload for tooltip use.
5. Chart renders as an `AreaChart` (redesigned from a bare `Line` — same one series, same interpolation, now with a gradient fill under the line so the chart reads as "level filled up to here" rather than an abstract line): y-axis domain fixed `[0, 100]` with `%` unit (not derived from data min/max), x-axis uses `tsLabel`, one `Area` series (`batteryLevel`) stroked in the app's charge-accent color (`#A8FF60`) with a fading fill beneath it, no dot markers, monotone interpolation between points. Axis ticks and gridlines use the app's hairline/mono-text tokens instead of Recharts defaults.
6. Hover/focus on a point shows a tooltip built from that point's raw `ts` via `toLocaleString()` (date + time), plus the battery percentage value.

**Business rules**
- One chart point per telemetry snapshot row returned — no aggregation, bucketing, or dedup by day. If a vehicle has multiple snapshots on the same calendar date, they appear as multiple distinct points sharing the same x-axis label.
- Points are always chronological left-to-right (oldest → newest), regardless of the DB's descending fetch order, because the frontend reverses before rendering.
- Y-axis range is always 0–100%, never rescaled to the data's actual range.
- History is hard-capped at the 2000 most recent snapshots per vehicle. This cap is enforced server-side only (`LIMIT 2000` in SQL) — there is no client-side count, message, or visual cue indicating the cap was hit or that older data exists beyond it.
- The backend supports a `from`/`to` date range for `stateLog`, but the frontend never sets these variables — the UI always requests "everything up to the cap," with no way for a user to request an older or narrower window.
- `batteryRange` is fetched in the same query (`stateLog { ... batteryRange ... }`) but is not read anywhere in `TrendsPage` or `BatteryTrendChart` — it has no effect on rendering.

**System states**

| State | Condition | Behavior |
|---|---|---|
| Loading | `loading === true` **and** `data` is still `undefined` (i.e., first response for this query hasn't arrived) | `Loader` (segmented charge-rail indicator) is shown; nothing else renders. |
| Empty | Query has returned and `data.vehicle.stateLog` is an array of length 0 (vehicle has no telemetry snapshots at all, or none matched — in practice never filtered since no range is sent) | Chart is not rendered. Text "No history yet." is shown instead, with no further explanation or CTA. |
| Success | Query has returned and `stateLog` has ≥1 row | Chart renders per the flow above, wrapped in a `Paper` with the heading "Battery level over time". |
| Refetch (already has data) | A later refetch/poll occurs while `data` from a prior response already exists | Loader is **not** re-shown (guard is `loading && !data`); the page keeps rendering the previously-fetched chart/state until the new response replaces `data`. |
| Error (unhandled) | GraphQL request fails (network error, server error) | No dedicated error UI exists. Apollo's default behavior on error is `loading: false`, `data: undefined`; because `loading && !data` is now false, the page falls through past the loading branch, `log` defaults to `[]` (via `data?.vehicle?.stateLog || []`), and the page renders "No history yet." — **indistinguishable from a genuinely empty vehicle.** This is documented as shipped behavior, not treated as a defect to fix here. |

### Story 2 — Reach trends from nav

**Step-by-step flow**
1. Vehicle nav tabs (`Layout.jsx`) render only when the current route has a `vehicleId` param. When present, `SECTIONS` renders one MUI `Tab` per entry, in fixed order: Overview → Trips → Charging → **Trends** → State Log.
2. Each tab is a router link to `/v/${vehicleId}/${key}` (Trends key = `trends`), preserving whatever vehicle is currently selected.
3. Active-tab determination: `section = sectionFromPath(location.pathname)`; the `Tabs` component's `value` is compared against each `Tab`'s `value` (the section key) to decide which tab renders as active/selected. When the pathname resolves to `trends`, the Trends tab is marked active.
4. Clicking the Trends tab is a plain client-side route navigation to `/v/:vehicleId/trends` (same `vehicleId` as before the click) — this triggers Story 1's flow from step 1.

**Business rules**
- The Trends tab is visible only in the context of a selected vehicle (route must carry `:vehicleId`); it does not appear on vehicle-less routes (e.g. a vehicle list/selection screen).
- Tab order is fixed: Overview, Trips, Charging, Trends, State Log — Trends is not first or last.
- Navigating to Trends does not change or require re-selecting the vehicle; the same `vehicleId` carries over from whichever tab the user was previously on.

### Out of Scope (carried from business requirements, restated as functional exclusions)
- No computation of degradation/capacity-fade/rated-range-loss — nothing in the resolver or chart derives these from the raw `batteryLevel` series.
- `batteryRange` is fetched but has no functional effect (dead data on the wire).
- No date-range picker exists; the `from`/`to` capability on `stateLog` is unreachable from this page.
- No truncation indicator when the 2000-row cap is hit.
- No cross-vehicle comparison, export, or alerting logic.
- No distinct error state — see the Error row above for actual (non-)behavior.

## User Flow

**Entry point:** Vehicle nav bar (`Layout.jsx`) → "Trends" tab, alongside Overview/Trips/Charging/State Log. Route: `/v/:vehicleId/trends`.

### 1. First load, history present
- Tab click → route mounts `TrendsPage` → `VEHICLE_STATE_LOG_QUERY` fires for `vehicleId`.
- **Loading state:** `Loader`, no other content, shown only while `loading && !data` (no cached data yet).
- **Resolved:** `Paper` with heading "Battery level over time" + `BatteryTrendChart` (filled area, battery % vs date, oldest→newest since the raw log is reversed before render).
- **Interaction:** hover only — tooltip shows full timestamp + battery %. No click, no filter, no date range control, no drill-down.
- **Exit:** any other nav-bar tab click (Overview/Trips/Charging/State Log) or browser back — unmounts the page, no confirmation/unsaved-state concerns since it's read-only.

### 2. First load, zero history
- Same query fires; resolves with an empty `stateLog` array.
- **Empty state:** chart area is replaced entirely by `Typography` "No history yet." — no chart shell, no axes, no illustration.
- No retry action, no link out (e.g., no "check back later" or "go to Overview" CTA) — user must use the nav bar to leave.

### 3. Navigating away and back (same vehicle)
- Apollo's default `cache-first` policy means the query is re-issued on remount, but if the vehicle's data is already in the Apollo cache from the earlier visit, it resolves synchronously from cache — no loader flash, no network round-trip, chart renders immediately with the same (now possibly stale) snapshot set. No polling, no refetch-on-focus.
- If the cache entry was evicted (e.g., cache reset elsewhere in the app) it behaves like a fresh first load (rung 1).

### 4. Switching vehicles while on the Trends tab
- Nav bar's vehicle switcher changes `:vehicleId` in the URL; `TrendsPage` re-renders with new `variables.id`, which is a new cache key for Apollo — so this is always a fresh lookup:
  - Never viewed before → loading (`Loader`) → chart or empty state per above.
  - Previously viewed in this session → served from cache instantly, no loader.
- No transient "switching…" state and no stale-data flash of the previous vehicle's chart (query key change means old `data` isn't reused for the new vehicle).

### Not handled (as implemented)
- No error UI: `error` isn't read from `useQuery`. A GraphQL/network failure leaves `data` undefined, `log` falls back to `[]`, and the page silently shows "No history yet." — indistinguishable from a genuinely empty vehicle.

**Files consulted** (read-only, not modified): `frontend/src/pages/TrendsPage.jsx`, `frontend/src/components/charts/BatteryTrendChart.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/App.jsx`, `frontend/src/graphql/queries/stateLog.js`, `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/types.js`, `backend/src/db/queries/telemetry.js`.
