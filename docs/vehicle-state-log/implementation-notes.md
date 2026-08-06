# Implementation Notes — Vehicle State Log

**Status:** Implemented and shipped. Read-only table, no dedicated backend code.

## Summary
`StateLogPage` renders the vehicle's state history as a 5-column table (Time/State/Locked/Climate/Inside-Outside temp), reusing the exact same `stateLog` GraphQL query/resolver/DB function that powers the unrelated `battery-health-trends` chart. Unlike `TrendsPage`, it does not reverse the rows — the table stays in the resolver's native newest-first order.

## Key files & roles
| File | Role |
|---|---|
| `frontend/src/pages/StateLogPage.jsx` | Fetches `VEHICLE_STATE_LOG_QUERY`, renders MUI `Table`; only feature-specific logic in the whole feature |
| `frontend/src/graphql/queries/stateLog.js` | `VEHICLE_STATE_LOG_QUERY` — shared verbatim with `battery-health-trends`, not state-log-specific |
| `backend/src/graphql/resolvers/types.js` (`Vehicle.stateLog`) / `backend/src/db/queries/telemetry.js` (`getStateLog`) | Same shared chain documented in `docs/battery-health-trends/implementation-notes.md` — nothing state-log-specific exists here |

## Notable gotchas
- **Two fields fetched, never rendered:** the query pulls `doorState` and `windowState` on every request but `StateLogPage` has no column for either — dead weight on the wire for this page's own needs (the fields exist because the query is shared with trends, not because state-log needs them).
- **No unit label:** Inside/Outside temps render as `Math.round(value)°` with no `C`/`F` suffix anywhere in the row or header. Whatever unit the backend stores in is what's shown, silently.
- **Three-way null handling, not two:** `Locked` and `Climate` are booleans in the schema, but the JSX ternary chain (`s.locked == null ? "—" : s.locked ? "Locked" : "Unlocked"`) treats them as tri-state — a `null` snapshot value (no report yet, or field genuinely absent) reads as `"—"`, distinct from both true and false. Easy to collapse into a plain boolean check by accident, which would turn `null` into `"Unlocked"`/`"Off"`.
- **Fully shared endpoint:** `Vehicle.stateLog` / `getStateLog` are owned by neither feature. The `MAX_STATE_LOG_ROWS = 2000` cap, `ORDER BY ts DESC`, and error cases documented in `docs/battery-health-trends/tech-spec.md` apply here unchanged — any change there silently affects this page too.
- **Swallowed errors look like empty state:** same pattern as `TrendsPage` — only `{ data, loading }` is destructured from `useQuery`, no `error`. A failed request renders "No history yet." identically to a vehicle with genuinely no history.

## Test coverage
- No test file exists for `StateLogPage.jsx` (`find` for `*statelog*` under `frontend/` returns only the page and the shared query module).
- Frontend has no test runner configured at all (no `test` script, no Jest/Vitest/RTL in `frontend/package.json`) — confirmed already for `battery-health-trends` in this same session, still true here. The null-handling ternaries, the unused `doorState`/`windowState` fetch, and the empty-state branch all have zero automated coverage.
- Backend coverage is identical to what's documented for `battery-health-trends`: `getStateLog` and the `Vehicle.stateLog` resolver are untested directly (only `getLatestSnapshot` and `efficiencyKmPerPercent` have dedicated tests, for unrelated features).
