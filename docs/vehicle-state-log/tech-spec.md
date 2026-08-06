# Tech Spec — Vehicle State Log

**Feature:** User-facing state history table (Time/State/Locked/Climate/temps)
**Status:** Already implemented and shipped. Grounded in `docs/vehicle-state-log/functional-spec.md`.

## Architecture

This feature has no architecture of its own. It shares the exact same `Vehicle.stateLog(from, to)` GraphQL query, resolver, `getStateLog` DB function, and `telemetry_snapshots` table as the `battery-health-trends` feature — all fully documented in `docs/battery-health-trends/tech-spec.md` (§ Architecture, § Data & API Design). That document is the source of truth for: the resolver chain, the full `TelemetrySnapshot` schema, the `MAX_STATE_LOG_ROWS = 2000` cap, ordering (`ORDER BY ts DESC`), error cases (`UNAUTHENTICATED`/`NOT_FOUND` via `requireOwnedVehicle`), and the exact `getStateLog` SQL. None of it is repeated here.

The only thing distinguishing this feature from battery-health-trends is client-side projection: `StateLogPage.jsx` takes the same query response (same query document, `VEHICLE_STATE_LOG_QUERY`, verbatim) and renders it as a 5-column table instead of a single-series chart, using the rows **in the order the resolver returns them** (newest-first) rather than reversing them for chronological display the way `TrendsPage` does.

**Frontend field-to-column mapping** (`StateLogPage.jsx`, the only feature-specific logic that exists):

| `TelemetrySnapshot` field | Table column | Rendering rule |
|---|---|---|
| `ts` | Time | `toLocaleString()` |
| `state` | State | raw string, no mapping |
| `locked` | Locked | `null → "—"`, `true → "Locked"`, `false → "Unlocked"` |
| `climateOn` | Climate | `null → "—"`, `true → "On"`, `false → "Off"` |
| `insideTemp`, `outsideTemp` | Inside / Outside | each independently rounded + `"°"` or `"—"` if null, joined `" / "` |
| `batteryLevel`, `batteryRange`, `odometer`, `doorState`, `windowState` | *(none)* | fetched by the shared query, unused by this page |

No new tables, no new resolvers, no new query document — this is a pure frontend read-side variant of an already-documented feature. There is nothing here that warrants an ADR: the only "decision" is which fields to project into which columns, which is UI-layer, not architecture.

**Files consulted** (read-only, not modified): `frontend/src/pages/StateLogPage.jsx`, `frontend/src/graphql/queries/stateLog.js`, `docs/battery-health-trends/tech-spec.md` (shared API reference).
