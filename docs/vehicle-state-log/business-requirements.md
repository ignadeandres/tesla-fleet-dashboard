# Business Requirements — Vehicle State Log

Status: retroactive documentation of shipped functionality.
Source of truth: `frontend/src/pages/StateLogPage.jsx`, `frontend/src/graphql/queries/stateLog.js`, `frontend/src/components/Layout.jsx`, `frontend/src/App.jsx`.

## Context

The "State Log" page (`/v/:vehicleId/statelog`) shows a **tabular history of raw vehicle state snapshots over time** for a single vehicle — one row per stored telemetry reading, most recent first.

This page shares the `Vehicle.stateLog(from, to)` GraphQL query/resolver with the separately-documented `battery-health-trends` feature (`docs/battery-health-trends/`). The resolver's full schema, error cases, DB query, and row-cap behavior are documented there and are **not repeated here**. This document covers only how the State Log page presents that shared data: which columns it renders, formatting rules, and page-level behavior.

## User Stories

### Story 1 — View vehicle state history as a table

As a fleet dashboard user with a linked vehicle,
I want to see a chronological table of my vehicle's recorded states,
so that I can review what the vehicle was doing (locked/unlocked, climate on/off, temperatures) at past points in time.

**Acceptance criteria**

- Given a vehicle with one or more stored telemetry snapshots, when the user opens `/v/:vehicleId/statelog`, a table renders with one row per snapshot, with columns in this order: **Time, State, Locked, Climate, Inside / Outside**.
- **Time** column: snapshot timestamp formatted with `toLocaleString()` (locale-dependent date + time).
- **State** column: the raw `state` string value from the snapshot, displayed as-is (e.g. `online`, `asleep`) — no label mapping or capitalization applied.
- **Locked** column: `"Locked"` if `locked` is `true`, `"Unlocked"` if `false`, `"—"` if `null`/not present.
- **Climate** column: `"On"` if `climateOn` is `true`, `"Off"` if `false`, `"—"` if `null`/not present.
- **Inside / Outside** column: rounded whole-degree values joined as `"{inside}° / {outside}°"`; either side independently shows `"—"` if `null`/not present. No unit label (°C vs °F) is shown.
- Rows are displayed in the order returned by the shared resolver (newest snapshot first) — the page does not reorder or reverse the result.
- Given a vehicle with zero stored telemetry snapshots, the table is not rendered and the text "No history yet." is shown instead.
- Given the underlying GraphQL query has not yet returned a first response, a loading spinner is shown in place of the table/empty-state text.
- The table container scrolls horizontally (`overflowX: auto`) rather than wrapping, so narrow viewports don't break the row layout.
- The history shown is subject to the same server-side row cap and default full-range behavior as documented in `docs/battery-health-trends/tech-spec.md` (§"DB query function") — no distinct behavior for this page.

### Story 2 — Reach the state log from vehicle navigation

As a fleet dashboard user viewing any section of a selected vehicle,
I want a direct way to get to that vehicle's state log table,
so that I don't have to construct the URL manually or lose vehicle context switching sections.

**Acceptance criteria**

- Given a vehicle is selected (route contains `:vehicleId`), a "State Log" tab is visible in the vehicle nav bar alongside Overview, Trips, Charging, and Trends.
- Clicking the "State Log" tab navigates to `/v/:vehicleId/statelog` for the currently selected vehicle and marks "State Log" as the active tab.

## Out of Scope (current iteration, as built)

- Displaying `batteryLevel`, `batteryRange`, or `odometer` in the table — all three are fetched by the frontend query but never rendered on this page.
- Displaying `doorState` or `windowState` in the table — both are fetched by the frontend query but never rendered anywhere in `StateLogPage.jsx`, despite door/window/lock data conceptually being part of "vehicle state."
- Displaying `speed`, `lat`/`lng`, `heading`, `softwareVersion`, or `tirePressure` — these fields exist on `TelemetrySnapshot` but are not even included in this page's query selection set.
- Date-range filtering/picker in the UI — the shared resolver accepts `from`/`to`, but `StateLogPage.jsx` calls the query with only `{ id: vehicleId }`, always requesting the full available (capped) history.
- Pagination, infinite scroll, or "load more" — the table renders every row the query returns in one pass.
- Any UI indication that history has been truncated at the server-enforced row cap.
- Sorting controls, column filtering, or column reordering.
- Export/download (CSV, etc.) of the log.
- Explicit error-state UI for a failed GraphQL request (only loading and empty states are handled today).
- Unit conversion or a temperature-unit selector — temperatures are shown as rounded numbers with a bare `°` symbol, no C/F distinction.

## Assumptions / Open Questions

- **Assumption:** newest-first row order (inherited unmodified from the resolver's `ORDER BY ts DESC`) is the intended presentation for a "log" view. Not explicitly confirmed with product, but consistent with typical log-reading conventions — flagged as an assumption rather than silently treated as a requirement.
- **Open question:** `doorState` and `windowState` are queried but never displayed on this page, even though the feature is colloquially described (per the originating request) as covering "locks, climate, doors, windows, temps." Unclear whether this is a partially-finished column set or an intentional decision to keep the table to five columns. Not assumed either way; listed as out of scope until a story requests adding these columns.
- **Open question:** same as the corresponding item in `docs/battery-health-trends/business-requirements.md` — whether the unused `from`/`to` date-range support on `stateLog` was built ahead of a planned UI filter (for either page) or is dead capability. Not assumed.
- **Assumption:** "No history yet." as the empty-state copy is intentional/final, not placeholder text, consistent with the same assumption made in the battery-health-trends documentation (same shared query, same empty condition).
- **Open question:** temperatures are rendered as `NN°` with no unit indicator. Unclear whether the underlying stored values are Celsius, Fahrenheit, or vehicle-locale-dependent, and whether the missing unit label is a known gap. Not resolved here.
- **Assumption:** absence of error-state handling in `StateLogPage.jsx` (a failed query leaves the page on the loading spinner or last-known data, no error message) reflects current shipped behavior, documented as-is rather than treated as a defect to fix, per this task's documentation-only scope.

---

Relevant files read (no edits made):
- `frontend/src/pages/StateLogPage.jsx`
- `frontend/src/graphql/queries/stateLog.js`
- `frontend/src/components/Layout.jsx`
- `frontend/src/App.jsx`
- `docs/battery-health-trends/business-requirements.md`
- `docs/battery-health-trends/tech-spec.md` (for cross-reference only — resolver/schema not re-documented here)
