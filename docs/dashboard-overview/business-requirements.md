# Business Requirements — Dashboard Overview

**Feature:** Per-vehicle Overview page (landing page) + Vehicle Selector
**Status:** Retroactive documentation of shipped behavior (no new scope)
**Source of truth:** `frontend/src/pages/OverviewPage.jsx`, `frontend/src/components/VehicleSelector.jsx`, `frontend/src/components/Layout.jsx`, `backend/src/graphql/schema.graphql`, `backend/src/graphql/resolvers/types.js`, `backend/src/db/queries/telemetry.js`

---

## User Stories

### Story 1 — View at-a-glance vehicle status

As a logged-in user, I want to land on an Overview page for my vehicle that shows its most recent known status, so that I can check on my car without digging through raw data.

**Acceptance Criteria**
- Given a user navigates to `/v/{vehicleId}/overview`, when the page loads and a snapshot exists, then it displays: vehicle name (displayName, falling back to VIN if displayName is not set), a state chip (only shown if `state` is non-null), and four stat cards — Battery (`{batteryLevel}%`), Range (`{batteryRange}` rounded, km), Odometer (`{odometer}` rounded, km), Locked (`Yes`/`No`).
- Given any individual stat field (`batteryLevel`, `batteryRange`, `odometer`) is `null`, when the page renders, then that stat card shows `—` instead of a value or a broken string.
- Given `locked` is `null` or `false`, when the page renders, then the Locked card shows `No` (the UI does not distinguish "unknown" from "unlocked" — it renders "No" for any falsy value).
- Given the query is loading and no cached data is yet available, when the page renders, then a loading spinner is shown in place of content.
- Given the vehicle has no telemetry snapshot at all (`latestSnapshot` is `null`), when the page renders, then the stat cards and map are not shown and the text "No telemetry yet." is displayed instead.

### Story 2 — See vehicle's last known location on a map

As a logged-in user, I want to see my vehicle's last known location plotted on a map, so that I know where it is without opening a separate app.

**Acceptance Criteria**
- Given the latest snapshot has both `lat` and `lng` non-null, when the Overview page renders, then a map is shown centered on `[lat, lng]` with a marker at that position.
- Given the marker is clicked/tapped, when its popup opens, then it displays "Last seen {timestamp}" where the timestamp is the snapshot's `ts` formatted via the browser's local date/time format (`toLocaleString()`).
- Given `lat` or `lng` is `null`, when the page renders, then no map is shown (stat cards still render if a snapshot exists).
- The map itself (tile provider, marker icon assets, container behavior) is the shared `Map` component already documented under Trips — this feature only documents that Overview reuses it with a single marker, not the component's internals.

### Story 3 — Manually refresh vehicle data

As a logged-in, non-demo user, I want to trigger an immediate refresh of my vehicle's data, so that I can see current status without waiting for the next scheduled poll.

**Acceptance Criteria**
- Given the logged-in user is not the demo account, when viewing the Overview page, then a "Refresh Now" button is visible in the page header.
- Given the demo account is logged in, when viewing the Overview page, then the "Refresh Now" button is not rendered at all (gating logic and rationale already documented in `docs/demo-mode/` — not re-specified here).
- Given a non-demo user clicks "Refresh Now", when the `refreshVehicle` mutation is in flight, then the button is disabled and its label changes to "Refreshing…".
- Given the `refreshVehicle` mutation completes successfully, when it resolves, then the Overview query is refetched so the page reflects the newly fetched snapshot.
- Given the `refreshVehicle` mutation fails, when the error is returned, then an error `Alert` is shown above the stat cards containing the error message, and the page does not crash (error is caught, not left as an unhandled rejection).

### Story 4 — See vehicle status even when the car is asleep

As a logged-in user, I want the Overview page to show my vehicle's current state (e.g. "Asleep") even when no fresh telemetry reading was captured for that state change, so that the status displayed is never stale or misleading.

**Acceptance Criteria**
- Given the most recent telemetry row has no `odometer` value (a bare state-transition row, e.g. a sleep event), when `latestSnapshot` is resolved, then the API returns the most recent row that *does* have an `odometer` reading, but overrides its `state` and `ts` with the values from the newer bare row.
- Given no telemetry rows exist for the vehicle at all, when `latestSnapshot` is resolved, then the API returns `null` and the frontend shows "No telemetry yet." (per Story 1).
- Given the most recent row already has a non-null `odometer`, when `latestSnapshot` is resolved, then that row is returned as-is (no fallback lookup needed).

*(This is backend behavior in `getLatestSnapshot` — documented here because it directly determines what Story 1's state chip and stat cards display.)*

### Story 5 — Switch between linked vehicles without losing context

As a user with one or more vehicles linked to my account, I want a way to switch which vehicle I'm viewing, so that I don't have to navigate back to a vehicle list every time.

**Acceptance Criteria**
- Given a logged-in user has at least one linked vehicle, when any vehicle-scoped page renders (Overview or any other tab), then a vehicle selector dropdown is shown in the app header, listing each vehicle by `displayName` (falling back to `vin`).
- Given a user has zero linked vehicles, when they view the app, then the vehicle selector is not rendered.
- Given a user selects a different vehicle from the dropdown while on the Overview tab, when the selection changes, then the app navigates to `/v/{newVehicleId}/overview` (i.e. the current section is preserved — switching vehicles from Trips stays on Trips, from Overview stays on Overview).

---

## Out of Scope (this iteration / this doc)

- Demo-account gating rules and rationale for disabling "Refresh Now" — already fully documented in `docs/demo-mode/`.
- Internals of the `Map` component (tile source, marker icon asset workaround, `MapContainer` config) — already documented under Trips.
- Vehicle linking / Tesla OAuth flow ("Link Tesla Account" button, `/auth/tesla/login`) — separate feature, not part of Overview.
- Any other Overview-adjacent tabs (Trips, Charging, Trends, State Log) — separate features with their own docs.
- Any UI treatment for the additional `TelemetrySnapshot` fields fetched by the Overview query but not currently rendered on the page (see Open Questions).
- Auto-refresh / polling cadence of telemetry data — this doc covers only the manual "Refresh Now" trigger and the read path; background polling is a separate, already-shipped concern (`docs/vehicle-telemetry-polling.md`) not re-described here.
- Any behavior for a user with zero linked vehicles landing on a vehicle-scoped route (no vehicle selector, no vehicleId) — not exercised by the current UI and not specified.

---

## Assumptions / Open Questions

- **[Assumption]** The Locked stat card intentionally treats `null` (unknown) and `false` (unlocked) identically, rendering "No" for both — this appears to be the actual shipped behavior, not confirmed as an intentional product decision vs. an overlooked edge case. Flagging rather than silently treating it as correct.
- **[Open question]** `VEHICLE_OVERVIEW_QUERY` fetches `speed`, `heading`, `softwareVersion`, `climateOn`, `insideTemp`, `outsideTemp`, `doorState`, `windowState`, and `tirePressure` on every load, but none of these are rendered anywhere on the Overview page today. Is this fetched-but-unused data intentional forward-provisioning for a near-term UI addition, or should the query be trimmed? Not addressed by this doc since no UI consumes it.
- **[Open question]** The vehicle selector renders whenever a user has **one or more** vehicles (not only when they have multiple) — so a single-vehicle account still sees a one-item dropdown. Confirm whether this is intended, or whether it should be hidden for single-vehicle accounts.
- **[Assumption]** "Last seen" timestamp in the map popup uses the browser's local timezone/locale formatting (`Date.prototype.toLocaleString()`) with no fixed format or explicit timezone label. Treated as current behavior, not a requirement to change.
- **[Open question]** There is no visible "last updated" / staleness indicator elsewhere on the page outside the map popup — if the snapshot is hours old, the stat cards give no visual cue. Not raising this as a gap to fix, only noting it's genuinely absent from current behavior.

---

## Reference Files (read, not modified)

- `frontend/src/pages/OverviewPage.jsx`
- `frontend/src/components/VehicleSelector.jsx`
- `frontend/src/components/Layout.jsx`
- `frontend/src/components/Map.jsx`
- `frontend/src/graphql/queries/vehicle.js`
- `frontend/src/utils/section.js`
- `backend/src/graphql/schema.graphql`
- `backend/src/graphql/resolvers/types.js`
- `backend/src/db/queries/telemetry.js`
