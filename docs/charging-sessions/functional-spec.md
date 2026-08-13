# Functional Spec — Charging Sessions

**Feature:** User-facing charging session history list (data capture is documented separately at `docs/vehicle-telemetry-polling/`)
**Status:** Already implemented and shipped. Elaborates `docs/charging-sessions/business-requirements.md`.

## Functional Behavior

### Scope
Page: `/v/:vehicleId/charging` — a read-only list of a vehicle's charging session history. All behavior below is derived from `ChargingPage.jsx`, the `VEHICLE_CHARGING_QUERY` GraphQL query, and the `chargingSessions` resolver chain (`requireOwnedVehicle` → `getChargingSessionsByVehicle`).

---

### Story 1 — View charging session history

**Trigger:** User navigates to `/v/:vehicleId/charging` for a vehicle they own.

**Flow:**
1. Page reads `vehicleId` from the route.
2. Client issues `vehicleId` charging-sessions query with `limit: 50` and no `offset` (offset is not sent; resolver/DB layer defaults it to `0`).
3. Server resolves the owning vehicle, then fetches charging sessions for that vehicle ordered by `start_time DESC`, capped at 50 rows. No further rows beyond the 50 most recent are ever fetched by this page (no pagination request path exists).
4. On success with ≥1 session, page renders a row-per-session list (redesigned from the original `Table` — same fields, no columns/headers anymore), most recent charge first, each row containing:
   - a header line with **Start** time (left) and duration (right);
   - a `ChargeRail` segmented gauge visualizing the session's battery range, filling to `endBatteryLevel` (or `startBatteryLevel` while in progress) with the `startBatteryLevel`→`endBatteryLevel` delta highlighted at full opacity and any charge already held before the session dimmed;
   - a footer line with the numeric **Battery** range (left) and **Energy added** (right).

**Row-level business rules:**

- **Start** — `startTime` formatted via `Date.toLocaleString()` (locale/timezone of the browser). Always present (`startTime` is non-null in the schema); every row renders a value here.
- **Duration**:
  - If `endTime` is present: `round((endTime - startTime) / 60000)` minutes, rendered as `"<N> min"`.
  - If `endTime` is null (session still open): literal text `"charging…"` (previously `"in progress"`), not a computed value. This value is static — it does not update live while the page is open; refreshing the page is required to see an updated duration once the underlying data changes.
- **Battery** — always renders as `"<startBatteryLevel>% → <endBatteryLevel or —>%"`.
  - `startBatteryLevel` is expected non-null per row (schema type is `Int` without a documented null-handling fallback in this component — if the source data has a null start level, the row will render the literal text `null%`, which is a rendering gap worth flagging if it's ever observed in production data, not something the UI code guards against).
  - `endBatteryLevel` null (in-progress or otherwise uncaptured) renders as the em-dash character, but note the trailing `%` from the template still appears after the dash (i.e. the cell literally shows `"72% → —%"`, not `"72% → —"`). This is the actual shipped rendering, not a typo in this spec.
- **Energy added** — `energyAddedKwh.toFixed(1)` + `" kWh"` when non-null; em-dash (`"—"`) when null. No unit shown for the em-dash case (no trailing "kWh" when the value itself is missing).
- **ChargeRail (new):** a 20-segment horizontal gauge (`frontend/src/components/ChargeRail.jsx`), shared with the Overview battery tile. `value` is `endBatteryLevel ?? startBatteryLevel` (so an in-progress session still shows a filled rail up to its last-known level); `from` is `startBatteryLevel`, used only to dim the pre-session portion of the fill so the segments actually charged during the session stand out.

**Out of scope for this story:** `lat`/`lng` are included in the GraphQL query payload but are never read or rendered by the page — see Open Questions.

---

### Story 2 — Empty state

**Condition:** Query completes successfully and returns zero charging sessions for the vehicle (new vehicle link, no charge history captured yet, or all data still pending capture by the separate ingestion feature).

**Behavior:**
- No list, no headers, no empty-list shell is rendered.
- Single line of secondary/muted text: **"No charging sessions recorded yet."**
- This state is mutually exclusive with the loading state and the list state — it only renders once loading has finished and the resolved session list length is exactly 0.

---

### Story 3 — Loading indicator

Two distinct loading conditions, driven by whether cached data already exists for this query/variables combination:

1. **Cold load (no cached data yet):**
   - Condition: `loading === true` AND `data` is not yet populated (`!data`).
   - Behavior: render the `Loader` (segmented charge-rail indicator) in place of any session list or empty-state text.

2. **Background refetch with existing cache (e.g., Apollo cache-and-network re-fetch, tab refocus, etc.):**
   - Condition: `loading === true` AND `data` already holds a previous successful result.
   - Behavior: continue showing the previously loaded list (or the previously resolved empty state) as-is. No loader is shown, and no loading affordance overlays the stale list. The user has no visual indication a refetch is in progress; the list simply updates in place once the refetch resolves (or stays stale silently if it fails — see error handling below, which is not specifically re-triggered by a background refetch failure in this component).

**Transition rule:** As soon as `loading` becomes `false` and `data` is populated, the page re-evaluates to either the empty state (Story 2) or the session list (Story 1) based on session count — never both, never neither.

---

### Story 4 — Ownership-scoped access

Access control happens server-side before any session rows are fetched; the frontend does not perform its own authorization check.

**Case A — Not authenticated:**
- No valid session/auth context on the request.
- Server returns a GraphQL error with `extensions.code = "UNAUTHENTICATED"` and no `vehicle`/`chargingSessions` data.
- Page-level behavior for this error is not distinguished in `ChargingPage.jsx` itself (no explicit `error` handling branch shown) — in practice this surfaces through whatever app-wide auth-error handling exists outside this page (e.g., redirect to login), not a charging-page-specific message. Flagging as an integration point rather than a page-owned behavior.

**Case B — Vehicle does not exist, or exists but is owned by a different user:**
- Server treats both cases identically: returns `extensions.code = "NOT_FOUND"`.
- No distinction is made between "this vehicle ID doesn't exist" and "this vehicle belongs to someone else" — both produce the same error code and (by implication) the same generic not-found treatment on the client. This is a deliberate anti-enumeration choice (confirmed by the `NOT_FOUND rather than FORBIDDEN` comment in `helpers.js`), not an oversight.
- No charging session data is returned in either sub-case.

**Case C — Vehicle exists and is owned by the requesting user:**
- Normal flow proceeds as in Story 1.

---

### Cross-cutting business rules

- **Result set ceiling:** exactly 50 most-recent sessions, no more, ever, via this page — regardless of how many total sessions exist for the vehicle. There is no affordance to view session 51+.
- **Ordering:** always `start_time DESC` (newest first); not user-controllable.
- **No client-side filtering, sorting, or search** — the rendered order and row set is exactly what the server returns.
- **In-progress sessions:** identified purely by `endTime == null`. Duration and end-battery-level both degrade to placeholder text/dash rather than being computed against "now."

---

### Open Questions / Flags carried into this spec (from business-requirements doc, confirmed against code)

- `lat`/`lng` are fetched in the GraphQL query but never read in `ChargingPage.jsx` — confirmed dead weight on the wire for this page as currently implemented. Unclear if reserved for a future map/location feature or leftover from a shared query shape.
- Battery cell renders `"—%"` (trailing percent sign after the em-dash) when `endBatteryLevel` is null, not a bare `"—"` — worth confirming with design/PO whether this is the intended display or an unnoticed cosmetic bug, since it wasn't called out explicitly in the source requirements.
- `startBatteryLevel` has no explicit null-handling in this component; behavior if that value is ever null in stored data is unverified/unhandled by the UI as written.
- No page-specific UI treatment observed for `UNAUTHENTICATED`/`NOT_FOUND` beyond the GraphQL error code itself — actual user-facing error UI (if any) lives outside this component and is out of scope for this spec unless surfaced separately.

## User Flow

### Entry points
- Tab navigation: from any other tab (Overview, Trips, Trends, State Log) within the same vehicle, via the `Charging` tab in the persistent `Layout` app bar (`frontend/src/components/Layout.jsx`).
- Direct/deep link to `/v/:vehicleId/charging` (bookmark, browser back/forward, page refresh).
- Vehicle switch via the `VehicleSelector` while already on the Charging tab — changes `:vehicleId`, which re-runs the query with new variables.

### Exit points
- Tab navigation to any other section (Overview, Trips, Trends, State Log) for the same vehicle.
- Log out (auth-level exit, outside this page's scope).
- No in-page navigation exists — there is no row click, drill-down, or modal, so the list itself is a dead end (unlike Trips, which exits to a per-trip map view).

### 1. First load, sessions present
1. User lands on `/v/:vehicleId/charging` (via tab click or direct link).
2. `VEHICLE_CHARGING_QUERY` fires with `{ id: vehicleId, limit: 50 }`; no cached data yet → `loading && !data` is true → the `Loader` is shown in place of the session list.
3. Query resolves → the loader is replaced by the session list, sessions rendered most-recent-first, one row per session, no pagination/filter/sort controls.
4. Screen is now static; user reads the list or navigates away via a tab.

### 2. First load, zero sessions
1. Same as above through query resolution.
2. `sessions.length === 0` → list is never rendered; instead a single line of secondary-colored text is shown: "No charging sessions recorded yet."
3. Terminal state for this vehicle until a session exists — no retry button, no polling; user must navigate away and back (or a new session must be recorded) to see it change.

### 3. Navigating away and back
- Leaving the Charging tab unmounts `ChargingPage`; returning to it remounts the component and re-issues the query.
- Apollo Client's default `cache-first` policy (no explicit `fetchPolicy` on this query, `frontend/src/graphql/queries/charging.js` + `frontend/src/pages/ChargingPage.jsx`) means: if the exact `{id, limit}` variables were already cached from the prior visit, the list renders immediately from cache with no loader and no network round-trip — it does not re-fetch fresh data on tab return within the same session.
- Switching vehicles produces new query variables, so it's treated as a fresh load (loader or empty state as in flows 1/2) rather than a cache hit.
- A full page reload clears the Apollo in-memory cache, so it always behaves like flow 1 or 2 on reload.

### 4. In-progress (still-charging) session in the list
- No separate screen/state — it's a row-level rendering rule within the same list, not a navigation state:
  - `endTime` is null → Duration column shows "in progress" instead of a computed minute count.
  - `endBatteryLevel` is null → Battery column shows "`{start}% → —%`".
  - `energyAddedKwh` is null → Energy added column shows "—".
- Because the query is not polled and the page doesn't auto-refresh, an in-progress row will keep showing "in progress" until the user leaves and returns to the tab (or reloads) after the session has ended and the cache/query is re-evaluated.

**Files consulted** (read-only, not modified): `frontend/src/pages/ChargingPage.jsx`, `frontend/src/graphql/queries/charging.js`, `frontend/src/graphql/client.js`, `frontend/src/components/Layout.jsx`, `frontend/src/App.jsx`, `backend/src/graphql/resolvers/{query,types,helpers}.js`.
