# Functional Spec — Vehicle State Log

**Feature:** User-facing state history table (Time/State/Locked/Climate/temps), shares the `Vehicle.stateLog` resolver with `battery-health-trends`
**Status:** Already implemented and shipped. Elaborates `docs/vehicle-state-log/business-requirements.md`.

## Functional Behavior

### Scope
Covers `/v/:vehicleId/statelog`: fetching and rendering vehicle state history for one vehicle, and reaching that page via the vehicle nav tabs. Grounded in `StateLogPage.jsx`, `Layout.jsx`, `stateLog.js` query, `types.js` resolver, `getStateLog` (shared with battery-health-trends — see `docs/battery-health-trends/functional-spec.md` for query/resolver detail, not re-documented here).

### Story 1 — View state history table

**Trigger:** user navigates to `/v/:vehicleId/statelog` (directly, via back/forward, or via the State Log tab).

**Step-by-step flow**
1. `StateLogPage` reads `vehicleId` from the route and fires `VEHICLE_STATE_LOG_QUERY` with `{ id: vehicleId }` only — `from`/`to` are never supplied, so the resolver returns an unbounded (server-capped) range, same as Trends.
2. Backend resolver `Vehicle.stateLog(from, to)` → `getStateLog` returns up to the **2000 most recent snapshots**, newest first (`ORDER BY ts DESC`).
3. Frontend takes the array **as returned, unmodified** — no reverse, no sort, no re-order (unlike Trends, which reverses for chronological chart display). Table rows render newest-first, top to bottom.
4. Each row renders five cells, each derived independently from that snapshot:
   - **Time:** `new Date(s.ts).toLocaleString()` — locale-formatted date + time, no raw ISO fallback.
   - **State:** `s.state` rendered verbatim — no mapping/prettification of the raw backend value (e.g. `"asleep"`, `"online"` show exactly as stored).
   - **Locked:** `s.locked == null ? "—" : s.locked ? "Locked" : "Unlocked"` — three-way, not two-way.
   - **Climate:** `s.climateOn == null ? "—" : s.climateOn ? "On" : "Off"` — same three-way pattern.
   - **Inside/Outside:** each side independently null-checked and rounded — `Math.round(s.insideTemp) + "°"` or `"—"`, then `" / "`, then the same for `outsideTemp`. A row can show `"21° / —"` if only one side is null; no unit letter (C/F) anywhere.
5. Table is wrapped in a `TableContainer` with `overflowX: auto`, so on narrow viewports the table scrolls horizontally rather than wrapping/collapsing columns.

**Business rules**
- Row order is exactly the resolver's order (newest-first) — this is a deliberate "log" reading, not a data artifact; contrast with Trends, which reverses the same payload for a chronological chart.
- Each of the four non-Time, non-State columns evaluates null independently per row and per side; there is no "if any field is null, blank the whole row" behavior — partial data renders partially.
- `state` has no client-side vocabulary/enum mapping — whatever string the backend stores is displayed as-is; a new/unexpected backend state value would render without breaking anything, just as unstyled text.
- History is hard-capped at the 2000 most recent snapshots per vehicle (server-side `LIMIT`, shared with Trends) — no client-side count, message, or cue that older rows exist beyond the cap.
- The `from`/`to` range capability exists on the query but is never invoked from this page — the table always shows "everything up to the cap," with no way to request an older or narrower window.
- Fields fetched by the query but never rendered in any cell: `batteryLevel`, `batteryRange`, `odometer`, `doorState`, `windowState`. This is on-the-wire dead data for this page — five of ten fetched fields have zero rendering effect. Whether `doorState`/`windowState` were meant to be a 6th/7th column is unresolved (see Open Questions in requirements) — current shipped behavior renders only 5 columns regardless.

**System states**

| State | Condition | Behavior |
|---|---|---|
| Loading | `loading === true` and `data` is still `undefined` (no response yet for this query) | `CircularProgress` spinner shown; nothing else renders — no table shell, no headers. |
| Empty | Query has returned and `data.vehicle.stateLog` is an array of length 0 | Table is **not rendered at all** (no headers, no empty-body placeholder row). `Typography` text "No history yet." is shown instead. |
| Success | Query has returned and `stateLog` has ≥1 row | Full table renders: header row + one row per snapshot, in resolver (newest-first) order, per the flow above. |
| Refetch (already has data) | A later refetch/poll occurs while prior `data` already exists | Spinner is **not** re-shown (guard is `loading && !data`); the previously-rendered table/state stays on screen until the new response replaces `data`. |
| Error (unhandled) | GraphQL request fails (network or server error) | No dedicated error UI. Apollo's default on error yields `loading: false`, `data: undefined`; the loading guard (`loading && !data`) is now false, `log` falls back to `[]` via `data?.vehicle?.stateLog || []`, and the page renders "No history yet." — **indistinguishable from a vehicle with genuinely zero snapshots.** Documented as shipped behavior, not a defect to fix here. |

### Story 2 — Reach state log from nav

**Step-by-step flow**
1. Vehicle nav tabs (`Layout.jsx`) render only when the current route has a `vehicleId` param, one `Tab` per `SECTIONS` entry in fixed order: Overview → Trips → Charging → Trends → **State Log** (State Log is last).
2. The State Log tab is a router link to `/v/${vehicleId}/statelog`, preserving the currently-selected vehicle.
3. Active-tab determination: `section = sectionFromPath(location.pathname)` is compared against each tab's `value` (`"statelog"`); when the pathname resolves to `statelog`, that tab renders active/selected.
4. Clicking the tab is a client-side route navigation to `/v/:vehicleId/statelog` (same `vehicleId`), which triggers Story 1's flow from step 1.

**Business rules**
- The State Log tab is visible only in the context of a selected vehicle (route must carry `:vehicleId`) — absent on vehicle-less routes.
- Tab order is fixed with State Log last (Overview, Trips, Charging, Trends, State Log).
- Switching to State Log does not change or require re-selecting the vehicle; `vehicleId` carries over from whichever tab was active before the click.

### Out of Scope (carried from business requirements, restated as functional exclusions)
- `batteryLevel`, `batteryRange`, `odometer` fetched but never rendered in any column — no functional effect.
- `doorState`, `windowState` fetched but never rendered — open question whether this is a missing column or intentional 5-column scope; current behavior is 5 columns, full stop.
- `speed`, `lat`, `lng`, `heading`, `softwareVersion`, `tirePressure` are not queried at all — not partially wired, simply absent from the request.
- No date-range filter UI — `from`/`to` on the shared query are unreachable from this page.
- No pagination and no truncation indicator when the 2000-row cap is hit.
- No sort, filter, or reorder controls — row order is fixed to resolver output.
- No export capability.
- No dedicated error-state UI — see the Error row above.
- No temperature unit selector or unit label on Inside/Outside values (unclear if backend values are Celsius or Fahrenheit — flagged, not resolved, by this spec).

## User Flow

**Entry point:** vehicle nav bar in `Layout.jsx` — "State Log" tab, routed to `/v/:vehicleId/statelog`, rendered alongside Overview/Trips/Charging/Trends. Reachable from any other vehicle tab by clicking the tab; no other entry point (not linked from Overview or elsewhere).

**1. First load, history present**
Tab click navigates to `/v/:vehicleId/statelog`. `VEHICLE_STATE_LOG_QUERY` fires (cache-first, no prior data for this vehicle) → spinner (`CircularProgress`) while in flight. On resolve, table renders with columns Time/State/Locked/Climate/Inside-Outside, newest snapshot first, no re-sort. No further transitions — page is static once loaded; exit only via nav tabs or vehicle selector.

**2. First load, zero history**
Same query fires, same spinner. On resolve, `log.length === 0` → table is not rendered at all; replaced by plain text "No history yet." No table shell, no explicit empty-state graphic, no retry affordance. Exit same as above (nav tabs / vehicle selector).

**3. Navigate away and back**
Leaving the tab (e.g., to Trends or Charging) unmounts `StateLogPage`. Returning re-mounts it and re-issues `useQuery` with the same `{ id: vehicleId }` variables. Since neither StateLog nor Trends sets a `fetchPolicy`, both use Apollo's default `cache-first` — same query + same variables means both pages read/write the **same normalized cache entry**. So: if Trends was visited first for this vehicle, returning to State Log serves cached data instantly (table appears with no spinner); if this is genuinely the first fetch for that vehicle in the session, spinner shows once. No background refetch on remount — data can go stale until a full reload or an unrelated cache write invalidates it.

**4. Switching vehicles while on this tab**
`VehicleSelector` changes `vehicleId` in the URL; `StateLogPage` stays mounted (same route, same component), `useParams().vehicleId` updates, and `useQuery`'s `variables` change triggers a new fetch under a new cache key. Because `loading && !data` gates the spinner (not `loading` alone), and `data` still holds the *previous* vehicle's result until the new response lands, there's a brief window where the old vehicle's table (or empty-state text) stays visible before snapping to the new vehicle's result — no explicit "switching" transition state, just a stale-then-replace flip. No error path exists if the fetch fails.

**Note:** structurally identical in flow shape to Trends and Charging Sessions pages — one query, one loading gate, one empty-state string, no drill-down/filter/sort states, no error UI in the component itself.

**Files consulted** (read-only, not modified): `frontend/src/pages/StateLogPage.jsx`, `frontend/src/graphql/queries/stateLog.js`, `frontend/src/components/Layout.jsx`, `frontend/src/utils/section.js`, `backend/src/graphql/resolvers/types.js`, `backend/src/graphql/schema.graphql`, `docs/battery-health-trends/functional-spec.md` (reference for shared resolver/cap behavior).
