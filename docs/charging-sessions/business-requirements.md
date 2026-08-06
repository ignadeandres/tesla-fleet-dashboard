# Business Requirements: Charging Session History (User-Facing View)

**Status:** Retroactive documentation — feature already shipped.
**Scope:** How captured charging session data is queried and displayed to the end user. Data *capture* (charging-state detection, `charging_sessions` row insertion) is documented separately at `docs/vehicle-telemetry-polling/` and is explicitly not re-covered here.

**Code grounding (read prior to writing this doc):**
- `frontend/src/pages/ChargingPage.jsx`
- `frontend/src/graphql/queries/charging.js`
- `backend/src/graphql/schema.graphql` (`ChargingSession` type, `Vehicle.chargingSessions` field)
- `backend/src/graphql/resolvers/types.js` (`Vehicle.chargingSessions` resolver)
- `backend/src/graphql/resolvers/query.js`, `backend/src/graphql/resolvers/helpers.js` (`requireOwnedVehicle`)
- `backend/src/db/queries/charging.js` (`getChargingSessionsByVehicle`)
- `frontend/src/App.jsx` (route `/v/:vehicleId/charging`, behind auth)

---

## User Stories

### Story 1 — View charging session history for my vehicle
As a logged-in vehicle owner, I want to see a list of my vehicle's past charging sessions, so that I can review when I charged, how much battery was added, and how long each session took.

**Acceptance Criteria**
- Given I am authenticated and navigate to `/v/:vehicleId/charging` for a vehicle I own, when the page loads, then I see a table with columns: Start, Duration, Battery, Energy added.
- Sessions are ordered most-recent-first (`ORDER BY start_time DESC`).
- Start column shows the session's start time formatted with the browser's local date/time (`toLocaleString()`).
- Duration column shows whole minutes between start and end time (`Math.round((end - start) / 60000)`) when an end time exists; shows the literal text "in progress" when `endTime` is null.
- Battery column shows `startBatteryLevel% → endBatteryLevel%`; shows "—" in place of the end value when `endBatteryLevel` is null.
- Energy added column shows `energyAddedKwh` rounded to 1 decimal place with a "kWh" suffix; shows "—" when `energyAddedKwh` is null.
- Up to 50 sessions are fetched and displayed (`limit: 50` hardcoded in the page's query call); there is no pagination control, "load more," or offset input in the UI — sessions beyond the 50 most recent are not reachable from this page as currently built.

### Story 2 — See a clear empty state when I haven't charged yet
As a logged-in vehicle owner with no recorded charging sessions, I want a clear message instead of a blank table, so that I understand there's simply no data yet rather than thinking the page is broken.

**Acceptance Criteria**
- Given the `chargingSessions` query resolves with zero rows, when the page renders, then it shows the text "No charging sessions recorded yet." (secondary/muted text color) instead of a table.

### Story 3 — See a loading indicator while data is fetched
As a user opening the charging history page, I want feedback while data is loading, so that I know the page is working and not frozen.

**Acceptance Criteria**
- Given the query is in flight and no cached data is yet available for this vehicle/variables combination, when the page renders, then a spinner (`CircularProgress`) is shown in place of the table.
- Given cached data already exists (e.g., returning to the page) and a background refetch is in flight, then the previously loaded table is shown rather than the spinner (per `loading && !data` condition).

### Story 4 — Only ever see my own vehicle's charging sessions
As a logged-in user, I want charging session data restricted to vehicles I own, so that I cannot view another user's charging history.

**Acceptance Criteria**
- Given I query `chargingSessions` for a vehicle ID that does not exist, or exists but is owned by a different user, when the query resolves, then the API returns a GraphQL error with `extensions.code = "NOT_FOUND"` and no session data (ownership is not distinguished from non-existence in the error, per `requireOwnedVehicle`'s design).
- Given I am not authenticated, when the query is attempted, then the API returns a GraphQL error with `extensions.code = "UNAUTHENTICATED"`.

---

## Out of Scope (for this documentation pass / not implemented)

- Charging session **data capture** — worker/telemetry logic that detects charging state and inserts `charging_sessions` rows (see `docs/vehicle-telemetry-polling/`).
- **Location display**: `lat`/`lng` are fetched by the frontend's GraphQL query but are not rendered anywhere in `ChargingPage.jsx`. No map, address, or coordinate column exists today.
- **Pagination / "load more" UI**: the resolver and DB query accept `limit`/`offset`, but the frontend never varies them — always `limit: 50`, `offset` unset. No UI exists to reach older sessions.
- Filtering or sorting controls (e.g., by date range, by location).
- A single-session detail view/drill-down (no per-session route or modal exists; only the list view).
- Charging cost, currency, charger type/speed (AC/DC), or session-level notes — no such fields exist in the `ChargingSession` type.
- Live/auto-refreshing duration for in-progress sessions — the page performs one query on mount; an ongoing session's "in progress" label and elapsed time do not update without a manual reload.
- Export (CSV/PDF) of charging history.
- Any mobile-specific layout beyond the existing `overflowX: "auto"` table wrapper.

---

## Assumptions / Open Questions

- **Open question:** `lat`/`lng` are queried by the frontend but never displayed. Is this dead/unused code left from partial work, or intentionally fetched for a future feature? Documented here as *not currently part of the user-facing feature* either way.
- **Open question:** With no pagination UI and a hardcoded `limit: 50`, users with more than 50 historical charging sessions cannot see anything older than the 50 most recent via this page. Confirm whether this is an accepted limitation or a known gap to backlog.
- **Observation (not a requirement):** in-progress sessions show a static "in progress" label with no live duration counter; confirm this is acceptable rather than an oversight before treating "live duration" as a future ask.
- No assumptions were required beyond the above — all displayed fields, formatting rules, ordering, and access-control behavior were confirmed directly from the resolver, DB query, and page component source.

---

Relevant files read to ground this document:
- `frontend/src/pages/ChargingPage.jsx`
- `frontend/src/graphql/queries/charging.js`
- `backend/src/graphql/schema.graphql`
- `backend/src/graphql/resolvers/types.js`
- `backend/src/graphql/resolvers/query.js`
- `backend/src/graphql/resolvers/helpers.js`
- `backend/src/db/queries/charging.js`
- `frontend/src/App.jsx`
