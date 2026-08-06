# Trips — Business Requirements (Retroactive)

**Status:** Documenting shipped behavior as of commit `22bc01c`. No design changes proposed here. This doc covers only the user-facing display/query of trip history — trip *capture* (drive-state detection, `trips`/`trip_points` inserts) is documented separately at `docs/vehicle-telemetry-polling/`.

**Source of truth read for this doc:** `frontend/src/pages/TripsPage.jsx`, `frontend/src/components/Map.jsx`, `frontend/src/graphql/queries/trips.js`, `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/query.js`, `backend/src/graphql/resolvers/helpers.js`, `backend/src/graphql/resolvers/types.js`, `backend/src/db/queries/trips.js`, `frontend/src/App.jsx`.

## Context

A logged-in user can view a given vehicle's trip history at `/v/:vehicleId/trips`: a scrollable list of past trips (date, distance, duration, battery used, efficiency) next to a map showing the selected trip's GPS breadcrumb as a polyline over OpenStreetMap tiles.

---

## User Stories

### Story 1 — View a vehicle's trip history as a list
As a logged-in user, I want to see a list of my vehicle's past trips with key stats, so that I can review where and how much I've driven.

**Acceptance Criteria:**
- Given I navigate to `/v/:vehicleId/trips`, the system fetches up to the 30 most recent trips for that vehicle via `VEHICLE_TRIPS_QUERY` (`limit: 30`, no `offset` — the API supports pagination via `offset` but the frontend never sends one).
- Trips are ordered most-recent-first (`ORDER BY start_time DESC` in `getTripsByVehicle`).
- Each list row shows: start time (`toLocaleString()`), and a "·"-joined secondary line built from whichever of the following are present: distance in km (1 decimal, e.g. "12.3 km"), duration ("X min" under 60 min, else "Yh Zm"), battery used ("N% used", computed as `startBatteryLevel - endBatteryLevel`), and efficiency ("X.X km/%").
- A field is omitted entirely from the secondary line (not shown as a placeholder) when its underlying value(s) are null/falsy, **except** distance and duration, which show an em dash ("—") when missing.
- Given the vehicle has zero trips, the list shows "No trips recorded yet." instead of an empty list.
- The list container has a fixed max height (500px) with internal scrolling once it overflows.

### Story 2 — View a trip's route on a map
As a logged-in user, I want to select a trip and see its GPS breadcrumb on a map, so that I can visualize where I actually drove.

**Acceptance Criteria:**
- Given the trip list has loaded, the first trip in the list is selected by default (no click required).
- Clicking a trip row selects it (`selectedId` state) and re-centers/reloads the map for that trip.
- On selecting a trip, the system fetches that trip's route separately via `TRIP_ROUTE_QUERY` (`vehicle(id).trip(id).route`), scoped to the selected trip's `id` and the current `vehicleId`.
- The map is centered on the selected trip's `startLat`/`startLng` at zoom level 15, height 500px, rendered over OpenStreetMap tiles (`{s}.tile.openstreetmap.org`).
- Given the route query has returned at least one point, the full route is drawn as a single connected polyline (no per-point markers, no distinct start/end markers, no color-coding by speed).
- Given the route query has not yet returned data (or the route is empty), the map renders without a polyline (no loading spinner blocks the map itself — only the initial trip-list fetch shows the page-level spinner).
- Switching the selected trip fully remounts the map component (keyed by trip id) so the camera actually moves to the new trip's start point (documented react-leaflet limitation: `center`/`zoom` only apply on mount).

### Story 3 — Trips list scoped to routes, not fetched per row
As a user with many trips, I want route/GPS data loaded only for the trip I'm actually viewing, so that the page stays responsive instead of fetching 30 trips' worth of GPS breadcrumbs up front.

**Acceptance Criteria:**
- The trip list query (`VEHICLE_TRIPS_QUERY`) does not request `route` — only summary fields (times, distance, duration, lat/lng, battery levels, efficiency).
- Route data is fetched only for the currently selected trip, via a separate query (`TRIP_ROUTE_QUERY`) that is skipped entirely (`skip: !selected`) when no trip is selected.
- Server-side, `Vehicle.trip(id)` is a distinct resolver from `Vehicle.trips(...)`, so requesting one trip's route does not require or trigger loading of any other trip's route.

### Story 4 — Graceful handling of trips with no recorded location
As a user, I want a clear message instead of a broken/empty map when a trip has no GPS data, so that I understand why nothing is shown.

**Acceptance Criteria:**
- Given no trip is selected (e.g., the trip list is empty), the map panel shows "Select a trip to see its route." instead of a map.
- Given the selected trip's `startLat` or `startLng` is null, the map panel shows "This trip has no recorded location data." instead of rendering a map.

### Story 5 — Only the vehicle's owner can view its trips
As a user, I want other users to be unable to view my vehicle's trip history, so that my location/driving data stays private.

**Acceptance Criteria:**
- All routes in the app (including `/v/:vehicleId/trips`) are gated behind an authenticated session at the router level (`App.jsx`); unauthenticated users only ever see login/register.
- Server-side, resolving `vehicle(id)` (the parent of `trips`/`trip`) calls `requireOwnedVehicle`, which throws `UNAUTHENTICATED` if there's no session user, and `NOT_FOUND` (not `FORBIDDEN`) if the vehicle exists but belongs to a different user — so vehicle ownership isn't leaked via the error type.
- `Vehicle.trip(id)` additionally scopes its DB lookup to `WHERE vehicle_id = $1 AND id = $2`, so a trip ID cannot be looked up against a vehicle it doesn't belong to, independent of the parent ownership check.

### Story 6 — Efficiency is computed, not stored, and hidden when not meaningful
As a user, I want an efficiency figure (km driven per % battery used) only when it's a meaningful number, so that I'm not shown a misleading or divide-by-zero-adjacent stat.

**Acceptance Criteria:**
- `efficiencyKmPerPercent` is computed at read time by a GraphQL field resolver on `Trip` (`distanceKm / (startBatteryLevel - endBatteryLevel)`), not persisted in the `trips` table.
- Given `distanceKm`, `startBatteryLevel`, or `endBatteryLevel` is null, the resolver returns null and the UI omits the efficiency segment.
- Given net battery usage over the trip is zero or negative (e.g., regen/charging offset consumption), the resolver returns null rather than a zero/negative figure.

---

## Out of Scope (not implemented, do not assume otherwise)

- Pagination / "load more" UI for trips beyond the most recent 30 — `offset` is supported end-to-end (schema, resolver, DB query) but the frontend never sends a non-default value.
- Filtering or searching trips (by date range, distance, location, etc.).
- Editing or deleting a trip.
- Exporting trip data (CSV, GPX, etc.).
- Per-point detail on the map: no markers at start/end, no speed-based coloring, no hover tooltips showing timestamp/speed at a point.
- Live/in-progress trip tracking — the list and map only display whatever is in `trips`/`trip_points` at query time; there's no subscription/polling to show a currently-open (undriven-to-completion) trip updating live.
- Any aggregate/summary stats across trips (weekly/monthly totals, averages) — not present on this page.
- Correlating a trip with a charging session (e.g., "charged before/after this trip").
- Any offline caching or optimistic UI for the trips list or route.

---

## Assumptions / Open Questions

- **Open question:** `getTripsByVehicle` returns rows regardless of `end_time`/`distance_km` being null (an in-progress, not-yet-closed trip, per the capture-side state machine documented in `docs/vehicle-telemetry-polling/`). It's unconfirmed how such a row renders in this list — likely as a row with only a start time and no distance/duration/battery info (all segments falsy → empty secondary line) — since no code path here special-cases an "in-progress" trip.
- **Open question:** `formatDuration`'s `!seconds` check and the list row's `t.distanceKm ? ... : "—"` check both treat a legitimate `0` (a trip with 0 recorded distance or 0-second duration) the same as null/missing, displaying "—". Unclear if this is an accepted display quirk for very short/aborted trips or unnoticed.
- **Assumption:** The battery-used and efficiency segments are silently omitted (rather than shown as "—") when null, while distance/duration show "—" — this inconsistency in placeholder behavior is treated here as existing behavior, not something to reconcile in this doc.
- **Assumption:** A fixed 30-trip window with no pagination UI is an accepted v1 limitation for this iteration, not an oversight — flagging since the API already supports `offset`, making this an easy follow-up if a user with more history needs it.
- **Open question:** No visible loading state distinguishes "route still loading" from "route is genuinely empty" on the map panel — both render as a map with no polyline. Not clear if that ambiguity is acceptable.
