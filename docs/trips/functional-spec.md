# Functional Spec — Trips

**Feature:** User-facing trip history list + map (data capture is documented separately at `docs/vehicle-telemetry-polling/`)
**Status:** Already implemented and shipped. Elaborates `docs/trips/business-requirements.md`.

## Functional Behavior

### 1. Trip history list

**Trigger:** User navigates to `/v/:vehicleId/trips` for a vehicle they own.

**Flow:**
1. On mount, the page issues `VEHICLE_TRIPS_QUERY` for `vehicle(id: vehicleId).trips(limit: 30)`. No `offset` is sent (defaults to 0 server-side).
2. Server returns up to 30 trip rows for that vehicle, ordered by `start_time` descending (most recent first). No client-side re-sorting occurs.
3. Each returned row is rendered as a two-line list item (redesigned from the original single dot-joined caption — same underlying fields, restructured for legibility):
   - **Line 1:** `startTime` formatted via `Date.toLocaleString()` (left) and distance — `distanceKm.toFixed(1) + " km"` if `distanceKm` is truthy, else `"—"` (right, mono type, drive-blue).
   - **Line 2:** duration + efficiency on the left, battery-used + energy on the right, each joined with `" · "` where present:
     1. Duration: `formatDuration(durationSeconds)` — see rule below; `"—"` if `durationSeconds` is falsy.
     2. Efficiency: `"{efficiencyKmPerPercent.toFixed(1)} km/%"` — **omitted entirely** if `efficiencyKmPerPercent` is falsy (null, 0, or negative — see Story 6).
     3. Battery used: `"{startBatteryLevel - endBatteryLevel}% used"` — **omitted entirely** if either `startBatteryLevel` or `endBatteryLevel` is `null`.
     4. Energy: `"{energyUsedKwh.toFixed(1)} kWh"` — **omitted entirely** if `energyUsedKwh` is falsy.

**Business rules:**
- Duration formatting (`formatDuration`): `< 60` minutes → `"X min"` (rounded); `>= 60` minutes → `"Yh Zm"` (floor hours, remainder minutes).
- **Known inconsistency (documented, not fixed):** `distanceKm` and `durationSeconds` render `"—"` when falsy (including a legitimate value of `0`); `startBatteryLevel`/`endBatteryLevel`/`efficiencyKmPerPercent`/`energyUsedKwh` are silently dropped from line 2 when falsy instead of showing a placeholder. A trip with genuinely 0 km distance or 0-second duration is indistinguishable from one with missing data. This inconsistency survived the line-1/line-2 restructure — it's a data-rule gap, not a layout one.

**System states:**
| State | Condition | Behavior |
|---|---|---|
| Loading (initial) | `loading === true` and no cached `data` yet | Page renders a single centered `Loader` (segmented charge-rail progress indicator, replacing the earlier `CircularProgress` spinner) in place of the whole grid; list and map are not rendered. |
| Loading (refetch) | `loading === true` but `data` already present | No spinner shown — stale data stays on screen (Apollo cache-then-network behavior). |
| Empty | Query resolves with `trips.length === 0` | List area shows `"No trips recorded yet."` instead of any rows. |
| Success | `trips.length > 0` | Rows render as above; list container caps at 70vh height at md+ (35vh on narrow/portrait screens, where it stacks above rather than beside the map) with internal scroll, independently scrollable from the rest of the page. |
| Error | Query rejects | Not handled by the page (no explicit error UI) — Apollo's default (silently render with `data` undefined) applies. Flagged as an open gap, not a designed state. |

**Out of scope for this story:** load-more/pagination controls (offset is supported end-to-end by the API but never sent by the client, so trips beyond the 30 most recent are unreachable from the UI).

---

### 2. Trip route on map

**Trigger:** Trip list has rendered with at least one row, or user clicks a row.

**Flow:**
1. **Default selection:** `selectedId` state starts `null`. The page derives the *effectively selected* trip as `trips.find(t => t.id === selectedId) || trips[0]` — so with no explicit click, the first trip in the (already-sorted, most-recent-first) list is selected automatically once data loads.
2. **User selection:** Clicking a row calls `setSelectedId(trip.id)`, which re-derives the selected trip to that row and marks it visually selected (`selected` prop on the list item).
3. **Route fetch on selection:** Whenever the selected trip's `id` changes (including the initial auto-selection), a second query, `TRIP_ROUTE_QUERY`, fires for `vehicle(id: vehicleId).trip(id: selected.id).route`. This is a distinct request from the list query — no route data is fetched for unselected trips.
4. **Map render:** The map is centered on the selected trip's `startLat`/`startLng` at zoom level 15, rendered at `70vh` height at the `md` breakpoint and up (`45vh` below it — tall enough to fill most of the viewport either way, not a small fixed box) using a CartoDB basemap — dark-matter tiles in dark mode, light-all tiles in light mode, switching automatically with the app's theme mode (`frontend/src/theme/ModeContext.jsx`) — framed in a hairline-bordered panel.

**Layout order (portrait/narrow fix):** the list and map are MUI `Grid` items (`xs={12} md={4}`/`xs={12} md={8}`), so below the `md` breakpoint both go full-width and stack vertically in DOM order. Originally that put the list (up to 70vh tall) above the map, pushing the map — the actual point of this page — well off the initial screen on a phone. Both items now carry an `order` (`sx={{ order: { xs: 2, md: 1 } }}` on the list, `{ xs: 1, md: 2 }` on the map), so the map renders first and is visible without scrolling on narrow/portrait screens, while the side-by-side order at `md`+ (list left, map right) is unchanged.
5. **Polyline:** If `route.length > 0`, all returned points are connected into a single `Polyline`, styled in the app's "drive" accent color (`theme.tokens.drive` — a lighter sky blue than the primary "charge" accent, mode-dependent), weight 3 — no per-point markers, no start/end pins, no tooltips.
6. **Remount on trip switch:** The map component is keyed by `selected.id`. Switching the selected trip fully unmounts and remounts the map (rather than updating `center`/`zoom` props in place) — this is required because the underlying map library only applies `center`/`zoom` at mount time, not on prop update.

**Business rules:**
- Only one trip's route is ever fetched/displayed at a time.
- The route request is scoped by both `vehicleId` and `tripId` — a mismatched or foreign trip id returns nothing (see Story 5).

**System states:**
| State | Condition | Behavior |
|---|---|---|
| Route loading | `TRIP_ROUTE_QUERY` in flight for the selected trip | No loading indicator on the map — map renders immediately (centered, tiles loaded) without a polyline until data arrives. There is no visual distinction between "route still loading" and "route is genuinely empty" (documented gap). |
| Route has points | `route.length >= 1` | Single connected polyline drawn over the map. |
| Route empty | `route.length === 0` (after fetch resolves, or before it resolves) | Map renders with no polyline — bare tiles centered on the trip's start point. |

---

### 3. List/route query separation (data-fetching behavior, not a distinct visual story)

**Flow:**
1. `VEHICLE_TRIPS_QUERY` requests only summary trip fields (start/end time, distance, duration, battery levels, start lat/lng) — it does **not** request `route` for any trip, including the selected one.
2. `TRIP_ROUTE_QUERY` is the sole source of route/polyline data and only ever targets the single currently-selected trip.
3. `TRIP_ROUTE_QUERY` is **skipped** (`skip: !selected`) when there is no selected trip — i.e., when the trip list is empty. No network request is made in that case.
4. Server-side, `Vehicle.trip(id)` and `Vehicle.trips(limit, offset)` are independent resolvers with independent DB queries — selecting a trip never triggers a re-fetch of the list, and loading the list never fetches any route data.

**Business rule:** Regardless of list size (up to 30 rows), at most one route query is in flight at any time, driven purely by `selectedId`.

---

### 4. No-location handling

**Flow / business rule (evaluated top to bottom, first match wins):**
1. If there is no selected trip at all (only possible when the trip list is empty), the map panel shows `"Select a trip to see its route."` — no map is rendered.
2. Else, if the selected trip has `startLat == null` or `startLng == null`, the map panel shows `"This trip has no recorded location data."` — no map is rendered, and no route query result is used (the route query may still have fired, but its result is not displayed).
3. Else, the map renders as described in Story 2.

**Note:** This check only inspects the selected trip's *start* coordinates. A trip with a valid start location but a route containing zero points (e.g., GPS dropped mid-trip) is **not** caught by this rule — it falls through to Story 2's "route empty" state (bare map, no message), not this "no location data" message. These are two distinct empty states triggered by different conditions.

---

### 5. Authorization / ownership scoping

**Flow:**
1. **Route-level gate:** All application routes (including `/v/:vehicleId/trips`) require an authenticated session. An unauthenticated visitor is confined to login/register — the trips page never renders for them regardless of URL.
2. **Server-side vehicle resolution:** Every trips-related query goes through `vehicle(id)` first, which:
   - Throws `UNAUTHENTICATED` if there is no session user on the request context.
   - Throws `NOT_FOUND` (deliberately, not `FORBIDDEN`) if the vehicle exists but belongs to a different user — this avoids leaking whether a given vehicle id exists to a user who doesn't own it.
   - Returns the vehicle only if `vehicle.userId === session.user.id`.
3. **Trip-level scoping:** `Vehicle.trip(id)` additionally issues its DB lookup with `WHERE vehicle_id = $1 AND id = $2` — so even a valid session for a vehicle the user *does* own cannot retrieve a trip id belonging to a *different* vehicle (owned or not) by guessing/substituting the trip id.
4. **Trip list scoping:** `Vehicle.trips(...)` is likewise always filtered `WHERE vehicle_id = $1`, so the list can never surface another vehicle's trips.

**Business rule:** Ownership is enforced once at the `vehicle` resolver entry point and re-enforced at the trip-id level; there is no separate authorization check on `Trip.route` itself — it inherits trust from having already resolved a vehicle-and-trip-scoped `Trip` object.

---

### 6. Efficiency calculation

**Flow:** `efficiencyKmPerPercent` is not stored — it is computed at read time by a GraphQL field resolver on `Trip`, every time the field is requested (i.e., once per list row per list fetch).

**Business rules (evaluated in order):**
1. If `distanceKm`, `startBatteryLevel`, or `endBatteryLevel` is `null`, the field resolves to `null`.
2. Otherwise compute `used = startBatteryLevel - endBatteryLevel`.
3. If `used <= 0` (battery level stayed flat or *increased* over the trip, e.g., regen-only or a data anomaly), the field resolves to `null` — **not** `0` and **not** a negative number.
4. Otherwise the field resolves to `distanceKm / used` (a positive float, rendered to 1 decimal in the UI).

**Consequence for Story 1's rendering:** because the frontend uses a truthy check (`t.efficiencyKmPerPercent ? ... : null`), a `null` result here is correctly omitted from the secondary line — there is no scenario where a `0` or negative efficiency value could leak into the UI, since the resolver never produces one.

---

### Cross-cutting: trips with no `end_time` (in-progress / never-closed trips)

No code path special-cases a trip whose `end_time` (and by extension `distanceKm`, `durationSeconds`, `endBatteryLevel`, `endLat/endLng`) is still `null` — e.g., an interrupted or currently-open trip. Given the field-level rules above, such a row would render as:
- Primary: start time only.
- Secondary: `"—"` (distance) `· "—"` (duration) — battery-used and efficiency segments both omitted (their `null` inputs trigger omission).
- If it's the selected trip and has a valid `startLat`/`startLng`, the map still renders centered on the start point with whatever partial route points exist for it (Story 2 behavior is agnostic to whether the trip has closed).

This is an assumption based on tracing the existing field-level null-handling, not an explicitly designed behavior — flagged as an open question in the source requirements doc.

## User Flow

**Entry point:** `Trips` section tab in the per-vehicle `Layout` shell (`/v/:vehicleId/overview`, `/v/:vehicleId/trips`, ...). Reached by selecting a vehicle, then clicking the `Trips` tab.

### 1. First load — trips present
1. User lands on `/v/:vehicleId/trips`. `selectedId` state initializes to `null`.
2. Trip list query is in flight and no cached data yet → page renders a single centered `CircularProgress`, replacing the entire two-panel layout (list and map are not shown, not just the list).
3. Query resolves with ≥1 trip. Spinner is replaced by the two-panel layout:
   - **List panel** (left at md+, capped at 70vh; on narrow/portrait screens it stacks below the map instead — see the layout-order note in Story 2 — and caps at 35vh): all trips, most recent first, each row showing date/time, distance, duration, battery discharge, efficiency.
   - **Selection:** no row is explicitly marked selected via state yet, but the first trip in the list is used as the effective selection (`selectedId` is still `null`; `selected` falls back to `trips[0]`) — its row renders in the MUI "selected" visual state.
   - This triggers the per-trip route query for that first trip.
   - **Map panel** (right at md+, 70vh tall; stacks above the list at 45vh on narrow/portrait screens) mounts keyed to the first trip's id, centers/zooms on its start coordinates, and shows a marker there via Leaflet's default icon.
   - Once the route query resolves, a polyline is drawn over the map; there's no separate loading indicator for this — the map is already interactive and simply gains a line when the data arrives.
4. **Exit:** user picks another section tab, another vehicle, or navigates elsewhere in the app.

### 2. First load — zero trips
1. Same initial spinner behavior while the list query is in flight.
2. Query resolves with an empty trips array.
3. **List panel:** empty `List` renders no rows; below/in place of them, `"No trips recorded yet."` (secondary text).
4. **Map panel:** since there is no `trips[0]` to fall back to, `selected` is `undefined`. The route query is skipped entirely (`skip: !selected`), and the map panel shows `"Select a trip to see its route."` instead of a `Map` component — no Leaflet map is mounted at all in this state.
5. This is a terminal state for the page until trips exist (e.g., vehicle drives) — there's no manual empty-state action (no "refresh" control on this screen).

### 3. Selecting a different trip
1. Precondition: list is populated, some trip is currently selected (first trip by default, or a previously clicked one).
2. User clicks a different row in the list panel.
3. `setSelectedId` updates state synchronously; the clicked row becomes the visually selected `ListItemButton`, the previous selection loses that state.
4. `selected` now resolves to the newly clicked trip, which changes the route query's variables → a new `TRIP_ROUTE_QUERY` fires for that trip's id.
5. Because the `Map` component is keyed by `selected.id`, React fully unmounts the old map and mounts a new one — this is a full remount, not a pan/zoom transition. The new map instance initializes centered/zoomed on the new trip's start coordinates, with no marker/polyline until route data resolves.
6. There is no loading indicator during the gap between clicking and the polyline appearing (route data may lag briefly behind the remount) — the map is visible and usable immediately, the line simply pops in.
7. List panel itself doesn't reload or show any state change beyond the selection highlight — the list query isn't refetched on trip selection.

### 4. Selected trip has no location data
1. Applies whenever the currently selected trip (default or user-clicked) has `startLat == null || startLng == null`.
2. Map panel does not mount a `Map`/Leaflet instance at all in this case — it short-circuits before the map render branch.
3. Instead shows `"This trip has no recorded location data."` in the map panel's place.
4. Note the route query still fires for this trip (`skip` only depends on `selected` existing, not on it having coordinates) — the fetched route data is simply unused/unrendered since the `Map` component that would host the `Polyline` isn't mounted.
5. List panel is unaffected — the trip row remains selectable and shows its stats normally; only the map side reflects the missing-location state.
6. User can recover by clicking any other trip row with valid coordinates, returning to the normal map flow (case 3).

### 5. Navigating away and back
1. `selectedId` lives in local component `useState` inside `TripsPage`, with no persistence to URL, context, or storage.
2. Navigating to another section tab or another vehicle unmounts `TripsPage` entirely, discarding that state.
3. Returning to `/v/:vehicleId/trips` (same or different vehicle) is a fresh mount: `selectedId` resets to `null`, the trip list query re-runs (Apollo cache may serve it instantly or refetch depending on cache policy — the page-level spinner logic (`loading && !data`) means if cached data exists it renders immediately without the spinner, otherwise the spinner shows again), and the effective selection falls back to `trips[0]` again.
4. **Net effect:** trip selection does not persist across navigation — every fresh visit to the Trips page re-defaults to the most recent trip (or the appropriate empty state if the vehicle has none), never to whatever trip was selected on a prior visit.

**Implementation note:** the "first trip auto-selected" behavior is mechanism, not stored state — `selectedId` is never actually set to the first trip's id; the component always falls back to `trips[0]` whenever `selectedId` doesn't match any current trip (including on every fresh mount). This is why selection doesn't persist across navigation (flow 5).

**Files consulted** (read-only, not modified): `frontend/src/pages/TripsPage.jsx`, `frontend/src/components/Map.jsx`, `frontend/src/App.jsx`, `frontend/src/components/Layout.jsx`, `backend/src/graphql/resolvers/{query,types}.js`.
