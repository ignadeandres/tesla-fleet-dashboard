# Business Requirements — Demo Mode

**Feature:** Public, read-only, seeded demo account for portfolio/CV viewing
**Status:** Already implemented and shipped. This document reconstructs requirements from the existing code; it does not propose new scope.
**Source reviewed:** `backend/src/demo/context.js`, `scripts/seed-demo-data.js`, `backend/src/graphql/resolvers/{mutation,query,helpers,types}.js`, `backend/src/graphql/schema.graphql`, `backend/src/routes/teslaAuth.js`, `worker/src/poller.js`, `docker-compose.yml`, `frontend/src/pages/OverviewPage.jsx`, `frontend/src/pages/VehiclesPage.jsx`, `frontend/src/components/Layout.jsx`, `frontend/src/auth/LoginPage.jsx`, `frontend/src/graphql/queries/auth.js`, `README.md`.

Note: authentication-side details — the reserved demo email blocking `register`, the `isDemo` field/resolver mechanics, session cookies — are already covered in `docs/authentication/`. This document only covers those where they intersect the demo system itself (e.g. `isDemo` gating a mutation), not the auth mechanism generally.

---

## User Stories & Acceptance Criteria

### US-1 — Visitor reaches the demo automatically, with zero login step
As a portfolio/CV visitor with no Tesla account or dashboard credentials, I want to land in a working, populated dashboard without registering or logging in, so that I can evaluate the product with zero friction.

- Given `DEMO_MODE_ENABLED=true` and a request with no valid session cookie, `buildContext` resolves `ctx.user` to the seeded demo account (looked up once by `DEMO_EMAIL`, cached in-process) and the GraphQL `me` query returns that user directly — not `null`.
- Since the frontend's route gating (`docs/authentication/`, US-5) treats non-`null` `me` as "authenticated," an anonymous visitor is served the full authenticated app (Layout + vehicle pages) directly — `LoginPage` is never rendered, no click or credential entry required.
- Given `DEMO_MODE_ENABLED` is unset or any value other than the literal string `"true"`, an anonymous request resolves `ctx.user = null` and behaves as a normal unauthenticated visitor (`LoginPage`).
- Given the seeded demo user row does not exist yet (seed script never run), the fallback resolves to `null` and the visitor sees `LoginPage` — no error/crash.

### US-2 — Visitor can also reach the demo via explicit login
As a visitor who prefers (or needs) to log in explicitly, I want to log in with the published demo email/password, so that I reach the same demo experience deliberately.

- README documents the credentials: `demo@tesla-fleet-dashboard.dev` / `demo1234`.
- The `login` mutation treats the demo account identically to any other account: verifies the bcrypt hash seeded by the script, sets the standard session cookie, returns the user — no demo-specific branch in `login` itself.
- This path works independent of `DEMO_MODE_ENABLED` — it succeeds purely because the row exists in `users`, same code path as any real account.
- Whether reached anonymously (US-1) or via explicit login (US-2), the resulting session's `isDemo` is `true` in both cases (`User.isDemo` resolver: `user.email === DEMO_EMAIL`) — the two paths are behaviorally equivalent once resolved.

### US-3 — Demo account ships pre-populated with realistic fake data
As a visitor, I want the demo account to already contain a vehicle with telemetry history, trips, and charging sessions, so that every dashboard view has real-looking content instead of an empty state.

- Running `npm run seed:demo` (`scripts/seed-demo-data.js`) creates: one `users` row (`demo@tesla-fleet-dashboard.dev`, bcrypt-hashed `demo1234`) and one `vehicles` row ("Demo Model 3", VIN `DEMOVIN0000000001`, `tesla_vehicle_id 999999999`) owned by that user.
- 673 `telemetry_snapshots` (15-minute interval, trailing 7 days through now): battery discharges outside a nightly 02:00–06:00 simulated-charging window, clamped 20–100%; `state` alternates `"charging"`/`"online"` on that same window; fixed base GPS coordinates (Barcelona) with small random jitter per row.
- 5 `trips` (spaced ~26h apart, 25 min / 6.4 km each), each with 16 interpolated `trip_points` from the base coordinates to a fixed offset, with jitter.
- 3 `charging_sessions` (spaced ~48h apart, 3.5h duration, 35%→90% battery, +34.5 kWh), all at the base location.
- User and vehicle inserts are idempotent (`ON CONFLICT ... DO NOTHING` + re-select) — safe to re-run without duplicating the account or vehicle row (see Assumptions for the time-series tables, which are **not** idempotent).

### US-4 — Demo account cannot trigger a real vehicle wake/refresh
As the system, I want to block the demo account from calling `refreshVehicle`, so the public demo never attempts to wake/poll a live Tesla vehicle (there isn't one) or spend Tesla API quota.

- `refreshVehicle` checks `ctx.isDemo` first and throws `"Not available in demo mode"` (`FORBIDDEN`) before any vehicle lookup, rate-limit check, or Tesla API call — for both the anonymous-fallback (US-1) and explicit-login (US-2) demo sessions, since `isDemo` is keyed off email either way.
- This is the **only** mutation gated by `isDemo` in the schema. `login`, `register`, `logout` run unmodified for the demo account (`register`'s separate block on ever *recreating* this email is auth-side, documented in `docs/authentication/`, not repeated here).
- Frontend hides the "Refresh Now" button on the Overview page whenever `auth.user.isDemo` is true — a UI convenience; the backend check above is what actually enforces the restriction.

### US-5 — Demo account is not offered the Tesla-linking action (UI level)
As a visitor, I want the "Link Tesla Account" action to not be presented on the demo account, so a flow that isn't meant for a shared public account isn't offered as an option.

- "Link Tesla Account" is hidden on both the `Layout` header and the Vehicles page whenever `auth.user.isDemo` is true.
- This hiding is **UI-only** — see the gap logged under Assumptions/Open Questions; unlike `refreshVehicle`, there is no server-side `isDemo` check backing this restriction.

### US-6 — Visitor is visibly told they're in demo mode
As a visitor, I want a persistent visual indicator that I'm looking at demo data, so I don't mistake it for a real linked vehicle.

- `Layout` renders a "Demo Mode" MUI `Chip` in the header whenever `auth.user.isDemo` is true, alongside the vehicle selector; absent for regular authenticated users.

---

## Out of Scope (confirmed absent from the code)

- Automatic or scheduled reset/re-seeding of demo data — no cron/reset job exists anywhere in the repo; `npm run seed:demo` is a manual, host-run command.
- Per-visitor isolated demo accounts/data — there is exactly one shared demo user and one shared demo vehicle for every visitor.
- Ongoing/simulated telemetry updates to the demo vehicle after seeding — the worker (`worker/src/poller.js`) only polls vehicles joined to a `vehicle_tokens` row, and the seed script never creates one for the demo vehicle, so its data is static between reseeds (matches the README's "no real vehicle" claim, under normal use).
- A server-side block on the demo session reaching the real Tesla OAuth linking route (`/auth/tesla/login`) — see the gap below; only the button is hidden client-side.
- Any demo-specific restriction on mutations other than `refreshVehicle` — no other data-mutating GraphQL operation exists in the schema today (`login`, `register`, `logout`, `refreshVehicle` is the complete `Mutation` type).
- Demo-specific rate limiting/throttling of traffic — not present; the only rate limit in the codebase (`refreshVehicle`'s in-memory `lastRefreshAt`) is moot for demo since that mutation is blocked outright.
- Blocking the demo email from being used to `register` a new account — that's authentication-side behavior, documented in `docs/authentication/business-requirements.md` (US-1).

---

## Assumptions / Open Questions

- **Gap: the Tesla-linking route has no `isDemo` guard.** `/auth/tesla/login` (`backend/src/routes/teslaAuth.js`) only checks for a valid session cookie via `verifyToken(readSessionCookie(req))` — it never checks `isDemo`. A visitor who explicitly logged in with `demo@tesla-fleet-dashboard.dev`/`demo1234` (a real session cookie, per US-2) could navigate to that URL directly, bypassing the hidden button, and complete the real Tesla OAuth flow. On success this creates a real `vehicles` row + `vehicle_tokens` row owned by the shared demo user id — which the worker would then start polling (it only skips vehicles *without* a token row). That would attach one visitor's real Tesla data to the public demo account for every subsequent visitor to see, with no unlink mutation anywhere to undo it. Flagging as-is since this is a documentation task, not a fix; anonymous visitors (US-1's fallback, no real cookie) cannot reach this route (`readSessionCookie` finds nothing to verify), so the exposure requires the explicit-login path specifically.
- **Seed script is not idempotent for time-series data.** `users`/`vehicles` inserts are `ON CONFLICT ... DO NOTHING`-safe, but `telemetry_snapshots`, `trips`, `trip_points`, and `charging_sessions` inserts have no such guard. Re-running `npm run seed:demo` appends a second batch on top of the first rather than replacing it. Open question: is accumulating duplicate demo data on reseed intentional/acceptable, or was `seed:demo` only ever meant to run once per environment?
- **Silent no-op if demo mode is enabled but never seeded.** If `DEMO_MODE_ENABLED=true` but `seed:demo` was never run, the anonymous fallback in `buildContext` quietly resolves to `null` and visitors see `LoginPage`, with no warning/log surfaced anywhere. Assumption: acceptable, since README pairs enabling the flag with running the seed script as one setup step.
- **`DEMO_MODE_ENABLED` is a hardcoded literal in `docker-compose.yml`** (`DEMO_MODE_ENABLED: "true"`), not interpolated from an env var like the other settings in that file (e.g. `${DB_USER}`). Turning demo mode off in the deployed environment requires editing `docker-compose.yml` directly, not just an `.env` change. Flagging as an observation on the reviewed code, not a defect to fix here.
- **No test coverage for the demo fallback path.** Already noted in `docs/authentication/implementation-notes.md`: "`backend/src/demo/context.js` — `buildContext`'s cookie→user resolution and demo-mode fallback path untested." Carried over here since this feature depends entirely on that same function.

---

**Files reviewed for this document** (all read-only, none modified):
- `backend/src/demo/context.js`
- `scripts/seed-demo-data.js`
- `backend/src/graphql/resolvers/mutation.js`
- `backend/src/graphql/resolvers/query.js`
- `backend/src/graphql/resolvers/helpers.js`
- `backend/src/graphql/resolvers/types.js`
- `backend/src/graphql/schema.graphql`
- `backend/src/routes/teslaAuth.js`
- `worker/src/poller.js`
- `docker-compose.yml`
- `frontend/src/pages/OverviewPage.jsx`
- `frontend/src/pages/VehiclesPage.jsx`
- `frontend/src/components/Layout.jsx`
- `frontend/src/auth/LoginPage.jsx`
- `frontend/src/graphql/queries/auth.js`
- `README.md` (Demo section)
- `docs/authentication/business-requirements.md`, `docs/authentication/implementation-notes.md` (cross-referenced for scope boundary, unedited)
