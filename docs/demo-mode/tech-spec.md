# Tech Spec — Demo Mode

**Feature:** Public, read-only, seeded demo account
**Status:** Already implemented and shipped. Grounded in `docs/demo-mode/functional-spec.md`. No new tables — reuses schema documented in `docs/authentication/tech-spec.md` and `docs/vehicle-telemetry-polling/tech-spec.md`.

## Architecture

### Component integration

Demo mode is not a separate service or code path bolted alongside auth — it is a second resolution branch inside the single existing `buildContext(req, res)` function (`backend/src/demo/context.js`) that already runs before every GraphQL resolver. There is one identity-resolution pipeline, not two:

```
request
  │
  ▼
readSessionCookie(req) → token?
  │
  ├─ token valid → SELECT user by id → isDemo = (email === DEMO_EMAIL)   [priority 1]
  │
  ├─ no/invalid token, DEMO_MODE_ENABLED === "true" → resolve demo user by
  │      email (cached module-level id), isDemo = true                    [priority 2, fallback only]
  │
  └─ neither → user = null, isDemo = false                                [priority 3]
```

Priority 1 (a real, verified session cookie) always wins over the demo fallback — the demo branch only fires when no session exists at all. This means an anonymous visitor and a visitor who explicitly logged in with the published demo credentials (`demo@tesla-fleet-dashboard.dev` / `demo1234`) arrive at the identical `{user, isDemo: true}` shape via two different priority branches (2 and 1 respectively) — downstream resolvers cannot distinguish them, and are not meant to. The only place this distinction matters is that priority-1 resolution implies a real, verifiable session cookie exists in the browser, while priority-2 resolution implies none does (see Security Notes).

The demo user's Postgres id is looked up by email once per backend process and cached in a module-level variable (`demoUserId`), not re-queried per request — a deliberate perf shortcut that relies on the seed script being idempotent (it never changes the row's id on re-run) and on `DEMO_MODE_ENABLED` toggling requiring a process restart anyway (it's a `docker-compose.yml` env var, not a runtime flag).

### Why `isDemo` is derived, not stored

`isDemo` is computed fresh on every request from `user.email === DEMO_EMAIL` — never written into the JWT, the session cookie, or any column. Two reasons this is the existing design, not an oversight: (1) the same account can legitimately be reached via two different session-resolution paths (anonymous fallback vs. explicit login), and storing the flag at token-issuance time would require duplicating that branch logic in `signToken`/`login` as well as in `buildContext`, for no benefit — deriving it from the already-fetched `email` column is one line, reuses data already in hand, and can never drift out of sync with the account it describes; (2) the `User.isDemo` GraphQL field resolver independently re-derives the same value the same way, so there is exactly one source of truth (the `DEMO_EMAIL` constant) rather than a flag that could disagree with it. The trade-off accepted: this means `isDemo` gating is only as strong as whatever code path actually calls `buildContext` and checks the flag — a route that skips `buildContext` entirely (see Security Notes) gets no `isDemo` awareness at all, because there is nothing to store or fall back on.

### Seed script and schema

`scripts/seed-demo-data.js` introduces no new tables, migrations, or schema changes. It is a plain data-seeding script against the existing schema (`users`, `vehicles`, `telemetry_snapshots`, `trips`, `trip_points`, `charging_sessions`), executed manually (`npm run seed:demo`) rather than run automatically by any service at startup. It inserts exactly one `users` row (email/password-hash, `ON CONFLICT (email) DO NOTHING`) and one `vehicles` row (`ON CONFLICT (vin) DO NOTHING`) — both idempotent — then appends time-series rows (673 telemetry snapshots over 7 simulated days, 5 trips, 3 charging sessions) with no uniqueness constraint, so re-running the script duplicates history rather than replacing it. Notably, it never inserts a `vehicle_tokens` row for the demo vehicle — that table only gets a row for the demo user if the FB-5 gap below is actually triggered, which is also exactly the condition the poller uses to decide what to poll (`worker/src/poller.js` selects vehicles via `INNER JOIN vehicle_tokens`, so the seeded demo vehicle is deliberately excluded from live polling under normal operation).

### Security Notes

**This is the single highest-priority item in this document for the eventual security review.**

**The gap:** `GET /auth/tesla/login` (`backend/src/routes/teslaAuth.js`) performs exactly one check — `verifyToken(readSessionCookie(req))` resolves to *some* userId — and never checks `isDemo` or compares the resolved user's email against `DEMO_EMAIL`. It is a plain, unguarded `<a href>` in the frontend (hidden by conditional rendering only, no server-side route guard), so the only thing preventing a demo session from reaching it is UI omission, not access control.

**Who can trigger it:** Anyone who explicitly logs in via the published, public demo credentials (`demo@tesla-fleet-dashboard.dev` / `demo1234` — advertised in the README) and then navigates directly to `/auth/tesla/login` by URL instead of clicking the (hidden) button. This requires no privilege beyond what is publicly documented and intentionally handed out. The purely-anonymous fallback path (no explicit login) is **not** exploitable this way, because it never produces a real session cookie for the client to carry to that route — `verifyToken(readSessionCookie(req))` has nothing to verify and the route redirects to `/login`.

**What happens if triggered:** The visitor completes a genuine Tesla Fleet OAuth flow (real Tesla account, real consent screen) as the demo user. On success, `teslaAuth.js` writes real `vehicles` and `vehicle_tokens` rows attached to the **single shared demo user id** — there is no per-visitor identity, so "attached to the demo account" means attached to the one account every demo visitor shares.

**Blast radius:**
- **Public-facing, shared account:** the linked vehicle immediately becomes visible, via `User.vehicles`, to every subsequent visitor of the public demo — anonymous-fallback and explicit-login alike, since both resolve to the same shared user.
- **Ongoing Tesla API quota consumption:** the worker's polling query joins on `vehicle_tokens` with no `isDemo` exclusion, so once the row exists the worker starts polling that real vehicle on the normal live-vehicle schedule, indefinitely, against the linking visitor's real Tesla account quota (and against the app's own `TESLA_MAX_CALLS_PER_DAY` cap).
- **No recovery path:** there is no unlink mutation anywhere in the schema. Reversing this requires manual DB intervention (deleting the `vehicle_tokens` and `vehicles` rows directly) — there is no in-product way for the linking visitor, an operator, or anyone else to detach the vehicle once attached.
- **Data exposure direction:** this is the linking visitor's *own* vehicle telemetry (location, battery, charge state, etc.) being exposed outward to the public — a real person's real vehicle data becomes world-readable through the demo, not a demo-data leak inward.

**Not in scope of this document:** no fix is proposed or implemented here (per functional spec FB-5); this section exists so a security engineer picking this up does not need to re-derive the attack path from `teslaAuth.js`, `context.js`, and `poller.js` independently. The two structurally sound places to close this are (a) an `isDemo` check inside `/auth/tesla/login` itself, mirroring the one already proven out in `refreshVehicle`, and/or (b) excluding `DEMO_EMAIL`'s user id from ever reaching that route — either is a small, targeted addition to existing gating logic, not new infrastructure.

## Data & API Design

### 1. Domain model

No new entities. Demo mode is a behavior overlay on the existing `User`/`Vehicle` model (see `docs/authentication/tech-spec.md`, `docs/vehicle-telemetry-polling/tech-spec.md`), expressed entirely through a derived `isDemo` flag computed from `user.email === DEMO_EMAIL`. Nothing is persisted for "demo-ness" — no column, no table, no session claim.

### 2. API design

**`User.isDemo: Boolean!`** — `backend/src/graphql/schema.graphql`

```graphql
type User {
  id: ID!
  email: String!
  isDemo: Boolean!
  vehicles: [Vehicle!]!
}
```

Resolver — `backend/src/graphql/resolvers/types.js`:

```js
isDemo: (user) => user.email === DEMO_EMAIL,
```

Computed from the resolved `user` object itself, not `ctx.isDemo` — deliberate, since `ctx` is built once per request before any mutation runs and can't reflect a user a `login`/`register` mutation just resolved in that same request. No separate query/arg surface; it's a plain field on every `User` returned anywhere (`me`, `AuthPayload.user`).

**`refreshVehicle(id: ID!): TelemetrySnapshot!`** — demo-mode error case, `backend/src/graphql/resolvers/mutation.js`:

| Condition | Response |
|---|---|
| `ctx.isDemo === true` | `GraphQLError("Not available in demo mode", { extensions: { code: "FORBIDDEN" } })` |
| `ctx.isDemo === false` | proceeds to normal ownership check / rate limit / Tesla call, per `docs/vehicle-telemetry-polling/tech-spec.md` |

Check runs first, before `requireOwnedVehicle` — a demo-mode caller gets `FORBIDDEN` even for a vehicle they don't own, not a not-found/ownership error.

No other mutation checks `ctx.isDemo`; `login`, `register`, and `logout` are unaffected (a demo account can still log in/out via its published credentials).

**REST endpoint inventory note:** `GET /auth/tesla/login` (Express route, outside the GraphQL schema) performs no `isDemo` check — this is the gap already detailed in the Architecture section, listed here as it's the one non-GraphQL entry in this feature's endpoint surface.

### 3. Seed script interface

Entry point: `scripts/seed-demo-data.js`, invoked via `npm run seed:demo` (`package.json` → `"seed:demo": "node scripts/seed-demo-data.js"`). No CLI args, no exported function — a self-executing `async function seed()` called at module load, run once as an operational step (not imported by app code).

Writes, in one transaction:
- 1 `users` row (`DEMO_EMAIL` / bcrypt hash of `DEMO_PASSWORD`)
- 1 `vehicles` row (`vin = "DEMOVIN0000000001"`)
- 673 `telemetry_snapshots` rows (7 days, 15-min cadence, synthetic battery/charge curve)
- 5 `trips` rows, each with 16 `trip_points` rows
- 3 `charging_sessions` rows

Full column shapes are the same tables documented in `docs/vehicle-telemetry-polling/tech-spec.md` — not repeated here.

**Idempotency boundary:** `users` (`ON CONFLICT (email) DO NOTHING`) and `vehicles` (`ON CONFLICT (vin) DO NOTHING`) are safe to re-run. `telemetry_snapshots`, `trips`, `trip_points`, and `charging_sessions` inserts have no conflict guard — re-running `seed:demo` against an already-seeded database appends a second set of time-series rows rather than replacing or skipping them.

### 4. Config surface

| Var | Read in | Set in | Match behavior |
|---|---|---|---|
| `DEMO_MODE_ENABLED` | `backend/src/demo/context.js:8` — `process.env.DEMO_MODE_ENABLED === "true"` | `docker-compose.yml:38` — `DEMO_MODE_ENABLED: "true"` (hardcoded literal, not `${VAR}`-interpolated like sibling settings in that file) | Strict string equality against `"true"`. Any other value (`"1"`, `"TRUE"`, unset, empty) is treated as disabled — no anonymous fallback, `ctx.user = null`. |

**Files consulted** (read-only, not modified): `backend/src/demo/context.js`, `scripts/seed-demo-data.js`, `backend/src/graphql/resolvers/{mutation,types}.js`, `backend/src/graphql/schema.graphql`, `backend/src/routes/teslaAuth.js`, `worker/src/poller.js`, `docker-compose.yml`, `package.json`.
