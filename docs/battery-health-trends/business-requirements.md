# Business Requirements — Battery Health Trends

Status: retroactive documentation of shipped functionality (commit "Added efficiency metrics" and related work).
Source of truth: `frontend/src/pages/TrendsPage.jsx`, `frontend/src/components/charts/BatteryTrendChart.jsx`,
`backend/src/graphql/schema.graphql` (`Vehicle.stateLog`, `TelemetrySnapshot`), `backend/src/graphql/resolvers/types.js`,
`backend/src/db/queries/telemetry.js`.

## Context

Despite the feature/page name, the shipped "Trends" page shows **raw battery level (%) over time** for a single
vehicle — a time series of point-in-time telemetry readings. It does not compute or show battery degradation,
capacity loss, or any age/mileage-adjusted health metric. Per-trip efficiency (`Trip.efficiencyKmPerPercent`)
is a separate, already-existing capability on the `Trip` type and is not surfaced on this page.

Note: this page shares the `Vehicle.stateLog(from, to)` GraphQL query with the separately-documented `vehicle-state-log` feature (`docs/vehicle-state-log/`) — both consume the same underlying telemetry history, projected differently.

## User Stories

### Story 1 — View battery level history for a vehicle

As a fleet dashboard user with a linked vehicle,
I want to see how my vehicle's battery level has changed over time,
so that I can spot patterns in charging/discharging behavior at a glance.

**Acceptance criteria**

- Given a vehicle with one or more stored telemetry snapshots, when the user opens `/v/:vehicleId/trends`, a line
  chart titled "Battery level over time" renders with one point per snapshot.
- The chart y-axis is fixed to 0–100% and labeled with a `%` unit.
- The chart x-axis shows the snapshot date (`toLocaleDateString` formatting) and points are ordered chronologically
  (oldest to newest, left to right).
- Hovering/tapping a point shows a tooltip with the full timestamp (`toLocaleString` formatting) and the battery
  percentage at that point.
- Given a vehicle with zero stored telemetry snapshots, when the user opens the page, the chart is not rendered and
  the text "No history yet." is shown instead.
- Given the underlying GraphQL query has not yet returned a first response, a loading spinner is shown in place of
  the chart/empty-state text.
- The displayed history is limited to the 2000 most recent snapshots for the vehicle (server-enforced cap); no
  UI affordance exists to view snapshots beyond that cap.

### Story 2 — Reach battery trends from vehicle navigation

As a fleet dashboard user viewing any section of a selected vehicle,
I want a direct way to get to that vehicle's battery trend chart,
so that I don't have to construct the URL manually or lose vehicle context switching sections.

**Acceptance criteria**

- Given a vehicle is selected (route contains `:vehicleId`), a "Trends" tab is visible in the vehicle nav bar
  alongside Overview, Trips, Charging, and State Log.
- Clicking the "Trends" tab navigates to `/v/:vehicleId/trends` for the currently selected vehicle and marks
  "Trends" as the active tab.

## Out of Scope (current iteration, as built)

- Battery degradation, capacity-fade, or rated-range-loss-over-time metrics — not computed anywhere in the backend.
- Displaying `batteryRange` (rated range in miles/km) on the trend chart — the field is fetched by the frontend
  query but never rendered.
- Per-trip efficiency (`Trip.efficiencyKmPerPercent`) on this page — that field exists but belongs to the Trips
  feature, not Trends.
- Date-range filtering/picker in the UI — the backend `stateLog(from, to)` resolver accepts a range, but
  `TrendsPage.jsx` never passes one; the page always requests the full available (capped) history.
- Any UI indication that history has been truncated at the 2000-row cap.
- Cross-vehicle comparison, export/download of trend data, or alerting on abnormal battery drops.
- Explicit error-state UI for a failed GraphQL request (only loading and empty states are handled today).

## Assumptions / Open Questions

- **Naming mismatch (open question):** the feature/directory is named "battery-health-trends" and the nav tab
  says "Trends," but the page itself displays only raw battery level over time, not a health/degradation metric.
  Flagging for product awareness — not resolved here, since resolving it either way would be inventing scope.
- **Assumption:** "No history yet." is the intended final empty-state copy, not a placeholder pending future
  polish.
- **Open question:** `batteryRange` is queried by the frontend but unused by the chart — unclear whether this is
  leftover from an earlier version of the chart or intentional prep for a near-term addition. Not assumed either
  way.
- **Open question:** whether the unused backend `from`/`to` date-range support on `stateLog` was built ahead of
  a planned UI date filter, or is dead capability. Not assumed; listed as out of scope until a story requests it.
- **Assumption:** absence of error-state handling in `TrendsPage.jsx` (no error shown on failed query — page would
  just stay on the loading spinner or last-known data) reflects current shipped behavior, documented as-is rather
  than treated as a defect to fix, per this task's documentation-only scope.

---

Relevant files read (no edits made):
- `frontend/src/pages/TrendsPage.jsx`
- `frontend/src/components/charts/BatteryTrendChart.jsx`
- `frontend/src/graphql/queries/stateLog.js`
- `frontend/src/components/Layout.jsx`
- `frontend/src/App.jsx`
- `backend/src/graphql/schema.graphql`
- `backend/src/graphql/resolvers/types.js`
- `backend/src/db/queries/telemetry.js`
