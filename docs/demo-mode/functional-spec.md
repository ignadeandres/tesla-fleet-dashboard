# Functional Spec — Demo Mode

**Feature:** Public, read-only, seeded demo account
**Status:** Already implemented and shipped. Elaborates `docs/demo-mode/business-requirements.md`.

## Functional Behavior

### FB-1 — Access resolution (per-request identity)

Every request resolves identity once, in `buildContext`, before any resolver runs. This is a strict priority order, not a fallback chain of equal branches:

1. **Session cookie present and valid** → look up the user row by the id encoded in the token. If found, that row's `email` determines `isDemo` (`email === DEMO_EMAIL`). This branch applies identically to a real user's account and to an explicit demo login (FB-2) — the code path does not know or care which one it is.
2. **No valid session cookie, `DEMO_MODE_ENABLED === "true"` (exact string)** → resolve to the seeded demo user by email, `isDemo = true` unconditionally (no email comparison needed — the id was found via `DEMO_EMAIL` in the first place).
3. **Neither of the above** → `ctx.user = null`, `ctx.isDemo = false`.

Business rules:
- The demo user id is resolved by email once per process and cached in memory (`demoUserId` module-level variable) — not re-queried on every anonymous request. A stale/incorrect cache is only possible if the demo user's id changes without a process restart, which the seed script (idempotent insert) does not do.
- `DEMO_MODE_ENABLED` comparison is a strict string match against `"true"`. Any other value (`"1"`, `"TRUE"`, unset, empty) is treated as disabled — no anonymous fallback, `ctx.user = null`.
- If `DEMO_MODE_ENABLED = "true"` but no row exists for `DEMO_EMAIL` (seed never run), branch 2 resolves `id = null` and falls through to branch 3. Result: anonymous visitor sees an unauthenticated app state, identical to demo mode being off. No error surfaced to the client or logged server-side.
- `isDemo` is never stored on the session/token itself — it is derived fresh from the resolved user's email on every single request (via context, and again independently via the `User.isDemo` GraphQL field resolver on `email === DEMO_EMAIL`). There is no cached/stale `isDemo` value that could survive an email change.

### FB-2 — `me` query and app entry

- `me` returns the context user resolved above (`id`, `email`, `isDemo`, `vehicles[]`), or `null`.
- Frontend bootstrap treats `me !== null` as "authenticated" and renders the authenticated app shell (`Layout` + routed pages) directly; `me === null` renders `LoginPage`.
- **Net effect for an anonymous visitor with demo mode on and seeded:** no login screen is ever shown, no click or credential entry — the first response the browser gets already contains a non-null demo `me`.
- **Explicit login flow** (`login` mutation, `email`/`password` = `demo@tesla-fleet-dashboard.dev` / `demo1234`): behaves exactly like login for any other account — `bcrypt` compare against the seeded hash, session cookie set on success, no `DEMO_EMAIL`-specific branch in `login`. Failure (wrong password) returns the same `UNAUTHENTICATED` error any account would get; there is no reason for it to fail once seeded correctly.
- **Behavioral equivalence:** once resolved, an anonymous-fallback session and an explicit-login demo session are indistinguishable to every downstream resolver — both carry `isDemo = true`, both reference the same shared user id, both see the same shared vehicle. The only functional difference between them is *how they got there* (no cookie vs. real cookie) — which matters specifically for FB-5 below.
- `register` explicitly blocks `email === DEMO_EMAIL` (`BAD_USER_INPUT`, "Email already registered") independent of whether the row exists yet — prevents a visitor from ever re-registering/hijacking the reserved demo identity.

### FB-3 — Seed data generation (`npm run seed:demo`)

Running the script performs, in order, inside a single transaction:

1. **User**: insert `(demo@tesla-fleet-dashboard.dev, bcrypt(demo1234))`. `ON CONFLICT (email) DO NOTHING`, then re-select by email to get the id either way — safe to run repeatedly, never duplicates the account or rotates its password hash on a re-run.
2. **Vehicle**: insert one vehicle (VIN `DEMOVIN0000000001`, `tesla_vehicle_id 999999999`, "Demo Model 3" / "Model 3") owned by that user id. `ON CONFLICT (vin) DO NOTHING`, then re-select — same idempotency guarantee as the user row.
3. **673 `telemetry_snapshots`** (7 days × 24h × 4 per hour + 1, at exactly 15-minute intervals ending at "now" when the script runs):
   - Battery level starts at 80%, and for each 15-minute step: if local hour is in `[2, 6]` inclusive, battery **+1.2%** (simulated overnight charge window); otherwise **-0.15%** (simulated idle/standby drain). Clamped to `[20, 100]` after every step, so the pattern can flatten at the floor/ceiling rather than going out of range.
   - `state` = `"charging"` during that same 02:00–06:00 window, `"online"` otherwise. There is no `"driving"`/`"asleep"` state anywhere in the seeded snapshots.
   - `speed` is hardcoded `0` on every snapshot row (movement only exists in trip data, FB-3.4, not in the telemetry timeline).
   - Location = fixed Barcelona base coordinates (41.3874, 2.1686) + independent random jitter (±0.001°) on each of lat/lng, per row — so the vehicle appears to sit in roughly the same spot with GPS noise, never actually relocating between snapshots.
   - `odometer` increases monotonically and deterministically with each step going backward from "now" (older snapshots have a lower odometer than newer ones).
   - `battery_range` is derived as `round(battery_level * 4.1)` — not independently modeled.
4. **5 `trips`**, spaced exactly 26 hours apart counting back from "now" (so they interleave with, rather than align to, the 24h telemetry cycle): each is a fixed 25 minutes / 6.4 km, from the base coordinates to a fixed offset (+0.03°/+0.04°). Each trip gets 16 `trip_points` (17 rows: fractions 0/15 through 15/15) linearly interpolated between start and end coordinates with small jitter, and a synthetic speed value (30–70) per point — this is the only place a nonzero moving speed appears in the seed data.
5. **3 `charging_sessions`**, spaced 48 hours apart: each fixed at 3.5 hours, 35% → 90% battery, +34.5 kWh added, all at the base location. These are independent of, and not reconciled against, the battery pattern embedded in the telemetry snapshots (FB-3.3) — the two datasets can visibly disagree (e.g. a charging session claims a 35%→90% climb that the snapshot timeline, capped at +1.2%/15min, would take far longer than 3.5h to reproduce).

Idempotency rule (business-relevant, not just a code note): **only** the `users` and `vehicles` inserts are conflict-guarded. `telemetry_snapshots`, `trips`, `trip_points`, and `charging_sessions` have no uniqueness constraint or `ON CONFLICT` clause. Running `seed:demo` a second time against an already-seeded database appends a second full batch of time-series rows (all timestamped relative to the new "now") on top of the first, rather than replacing it — the demo vehicle would then show overlapping/duplicated history rather than a clean single week.

### FB-4 — Demo write restriction: `refreshVehicle`

`refreshVehicle` is the only mutation in the schema with any `isDemo` gate. Its check runs as the very first statement in the resolver, before vehicle ownership is verified, before the in-memory rate limiter is checked, and before any Tesla Fleet API call is attempted:

- `ctx.isDemo === true` → throw immediately, error code `FORBIDDEN`, message `"Not available in demo mode"`. No vehicle lookup happens, so this fires the same way regardless of which/whether vehicle id was passed, and regardless of whether the demo user even owns a vehicle with that id.
- `ctx.isDemo === false` → resolver proceeds exactly as for any real account: ownership check, 60-second per-vehicle rate limit, wake-if-asleep retry loop (5 attempts, 3s apart), Tesla API call, snapshot insert.
- This check applies identically whether `isDemo` was set via the anonymous fallback (FB-1 branch 2) or explicit login (FB-1 branch 1) — both produce `ctx.isDemo = true`.
- Frontend additionally hides the "Refresh Now" control on the Overview page when `isDemo`, but this is presentation only; a request to the mutation sent directly (bypassing the UI) is blocked by the same server-side check regardless of UI state. The backend check is what actually enforces the restriction — the hidden button is not a defense.
- No other mutation (`login`, `register`, `logout`) has any demo-specific behavior beyond what's already described in FB-2/FB-1.

### FB-5 — Tesla-linking exposure (confirmed gap, not a proposed fix)

"Link Tesla Account" is a plain link (`<a href="/auth/tesla/login">`), hidden via `isDemo` check in two places only: the `Layout` header button and the `VehiclesPage` empty-state button. Both are pure conditional rendering — no route guard, no disabled-but-present state.

The route it points to, `/auth/tesla/login`, performs exactly one check: `verifyToken(readSessionCookie(req))` must resolve to a userId. **It never inspects `isDemo` or compares the resolved user's email to `DEMO_EMAIL`.** Functional consequence, traced end to end:

- **Anonymous-fallback demo session (FB-1 branch 2):** no real session cookie exists in the browser (the demo identity was assigned server-side per-request, not via a cookie the client holds). `readSessionCookie` finds nothing, `verifyToken` has nothing to verify → this path cannot reach a state where OAuth linking would even start. **Not exploitable via this path.**
- **Explicit-login demo session (FB-1 branch 1, i.e. FB-2's explicit login):** this session *does* have a real, valid session cookie for the demo user id (identical mechanism to any real account's login). A visitor on this path who navigates directly to `/auth/tesla/login` (typing the URL, not clicking the hidden button) passes the route's only check and enters the real Tesla OAuth flow as the demo user.
- If that OAuth flow completes successfully, the resulting `vehicles` row and `vehicle_tokens` row are attached to the **shared** demo user id — not to any private per-visitor identity, since there is only one demo user account (see Out of Scope in the requirements doc: no per-visitor isolation).
- The background worker's poll-eligibility query is an `INNER JOIN` against `vehicle_tokens` — it has no `isDemo` awareness either. Once a `vehicle_tokens` row exists for the demo vehicle, the worker starts polling that real, linked vehicle on the normal schedule like any other.
- Net functional result: one visitor's real Tesla vehicle data becomes visible to **every** subsequent visitor of the public demo (anonymous and explicit-login alike, since both resolve to the same shared vehicle list via `User.vehicles`), consuming that visitor's real Tesla API quota on an ongoing basis. There is no unlink mutation anywhere in the schema to reverse this once triggered — recovery would require manual DB intervention.
- This document records the gap as-is (retroactive spec of shipped behavior); no fix is in scope here.

### FB-6 — "Demo Mode" indicator

- `Layout` renders a `Chip` labeled "Demo Mode" in the app header whenever `auth.user.isDemo === true`, positioned next to the vehicle selector.
- Sourced directly from the `me.isDemo` field returned by FB-2's query — no separate call, no client-side derivation from email.
- Absent (not rendered, not present-but-disabled) for any session where `isDemo` is falsy, including `null`/logged-out state.
- Purely informational — this flag does not itself gate any behavior; it is the same `isDemo` value FB-4 and FB-5's button-hiding key off, just surfaced visually as well.

### Cross-cutting state summary

| Entry path | `me` non-null? | `isDemo` | `refreshVehicle` | Link Tesla button shown | Can reach `/auth/tesla/login`? |
|---|---|---|---|---|---|
| Anonymous, `DEMO_MODE_ENABLED=true`, seeded | yes (demo user) | true | blocked (FORBIDDEN) | no | no (no session cookie) |
| Anonymous, `DEMO_MODE_ENABLED=true`, **not** seeded | no | — | n/a (unauthenticated) | n/a | n/a |
| Anonymous, `DEMO_MODE_ENABLED` off/unset | no | — | n/a (unauthenticated) | n/a | n/a |
| Explicit login with demo credentials | yes (demo user) | true | blocked (FORBIDDEN) | no | **yes — gap (FB-5)** |
| Any real registered account | yes | false | normal behavior | yes | yes (as intended) |

**Note on seed data internal consistency:** the seeded telemetry (`battery_level`) and the seeded `charging_sessions` are two independently generated datasets that aren't reconciled with each other (a charging session claims a 35%→90% jump in 3.5h that the telemetry's own +1.2%/15min charge rate can't reproduce in that time). A careful viewer could notice this discrepancy across the Trends/Charging pages.

## User Flow

**1. First-time anonymous visitor**

- Visitor hits the app URL with no session. With `DEMO_MODE_ENABLED=true`, they land directly inside the authenticated shell — no login screen — signed in as the seeded demo user.
- Header (`Layout.jsx`): a **"Demo Mode"** chip renders next to the vehicle selector, immediately signaling the account's status.
- Header: **"Link Tesla Account"** is absent (only rendered when `!auth.user.isDemo`).
- Navigating into a vehicle's Overview page: **"Refresh Now"** is absent (same `isDemo` guard; backend also rejects the mutation if called directly).
- Navigating to the Vehicles list page: same missing **"Link Tesla Account"** button under the vehicle list.
- No error states, empty states, or loading states differ from the authenticated flow — the chip and button omissions are the only visible signal of demo status.

**2. What the demo user can still do**

- Full read-only navigation: vehicle selector, all tabs (Overview, Trips, Charging, Trends, State Log) for every seeded vehicle, and the Vehicles list — identical to a real authenticated user.
- Log out is available (`Layout.jsx` "Log out" button is unconditional).
- Everything not explicitly gated by `isDemo` behaves exactly as it does for a real account; demo mode only removes the two write-triggering affordances (manual refresh, account linking).

**Files consulted** (read-only, not modified): `backend/src/demo/context.js`, `scripts/seed-demo-data.js`, `backend/src/graphql/resolvers/{mutation,types}.js`, `backend/src/routes/teslaAuth.js`, `worker/src/poller.js`, `frontend/src/components/Layout.jsx`, `frontend/src/pages/{OverviewPage,VehiclesPage}.jsx`.
