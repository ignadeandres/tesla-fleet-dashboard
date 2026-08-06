# Implementation Notes — Battery Health Trends

**Status:** Implemented and shipped. Read-only chart, no dedicated backend code.

## Summary
`TrendsPage` renders a line chart of raw battery percentage over time for a vehicle, by reusing the same `stateLog` GraphQL query/resolver/DB function that powers the unrelated `vehicle-state-log` feature. The frontend fetches the full snapshot row shape and discards everything except `ts`/`batteryLevel`.

## Key files & roles
| File | Role |
|---|---|
| `frontend/src/pages/TrendsPage.jsx` | Fetches `VEHICLE_STATE_LOG_QUERY`, reverses the DESC-ordered rows to chronological order, renders `BatteryTrendChart` or an empty-state message |
| `frontend/src/components/charts/BatteryTrendChart.jsx` | Recharts `LineChart`; maps `ts` → date label, plots `batteryLevel` on a fixed 0–100% y-axis |
| `frontend/src/graphql/queries/stateLog.js` | `VEHICLE_STATE_LOG_QUERY` — shared verbatim with `vehicle-state-log`, not trends-specific |
| `backend/src/graphql/resolvers/types.js` (`Vehicle.stateLog`) | One-line passthrough to `getStateLog(ctx.db, vehicle.id, from, to)`; no trends-specific resolver exists |
| `backend/src/db/queries/telemetry.js` (`getStateLog`) | Raw SQL, `ORDER BY ts DESC`, capped at `MAX_STATE_LOG_ROWS = 2000` regardless of date range |

## Notable gotchas
- **Naming mismatch:** the feature/folder is called "battery-health-trends" but there is no health or degradation calculation anywhere in the chain — it plots raw `batteryLevel` (0–100%) straight from telemetry snapshots. No capacity/SOH math exists in this codebase.
- **Fully shared endpoint:** `Vehicle.stateLog` and `getStateLog` are not owned by this feature — they're the same resolver/query `vehicle-state-log` uses. Any change there (schema, cap, ordering) silently affects both features. There is no way to touch "just trends" on the backend.
- **Client-side reversal is local:** `getStateLog` always returns newest-first; `TrendsPage` does `[...log].reverse()` before charting. This reversal exists only in `TrendsPage` — `StateLogPage` (the other consumer) keeps DESC order. Easy to break if someone "cleans up" by moving the sort into the query/resolver.
- **Swallowed errors look like empty state:** `TrendsPage` destructures only `{ data, loading }` from `useQuery` — no `error` is read or displayed. If the query errors (network failure, auth expiry, GraphQL error), `data` stays `undefined`, `log` defaults to `[]`, and the user sees "No history yet." identical to a genuinely empty vehicle history. There is no way for a user or a screenshot to distinguish "broken" from "no data yet."
- **Unbounded fetch, capped server-side:** the query is called with no `from`/`to` variables, so it always requests the full history; the only limit is the hard-coded `MAX_STATE_LOG_ROWS = 2000` in `getStateLog` (≈3 weeks of 1-minute polling). No pagination or date-range UI exists on `TrendsPage`.

## Test coverage
- **Backend:** `node --test` in `backend/` — 13/13 passing. None of them cover `getStateLog` or the `Vehicle.stateLog` resolver directly:
  - `backend/src/db/queries/telemetry.test.js` only tests `getLatestSnapshot` (fallback-row logic), not `getStateLog`.
  - `backend/src/graphql/resolvers/types.test.js` only tests `efficiencyKmPerPercent`, not the `Vehicle.stateLog` field resolver (which is a one-line passthrough, likely why it wasn't deemed worth a dedicated test).
- **Frontend:** no test runner is configured at all (`frontend/package.json` has no `test` script, no Jest/Vitest/RTL dependency). `TrendsPage.jsx` and `BatteryTrendChart.jsx` have zero automated coverage — including the empty-state branch and the error-swallowing behavior noted above.
- Net: the feature's actual delta (client-side reverse, `ts`/`batteryLevel` projection, empty-state branch) has no test anywhere in the repo. Coverage that exists is incidental, from testing the shared `getLatestSnapshot`/`efficiencyKmPerPercent` functions for other features.
