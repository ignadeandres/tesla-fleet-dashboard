# Implementation Notes — Authentication

**Feature:** Dashboard session auth (JWT/httpOnly cookie) + Tesla OAuth account linking
**Status:** Implemented and shipped. See `docs/authentication/tech-spec.md` for the full architecture/data/API design — this doc covers what's actually in the code, files touched, and gotchas found while reading it.

## Summary

Two independent auth mechanisms, both live in `backend`:

1. **Dashboard session auth** — email/password against `users`, a JWT (`sub: userId`, HS256, 30d default) stored in an httpOnly `session` cookie. Verified fresh on every `/graphql` request via `buildContext`.
2. **Tesla OAuth linking** — a plain Express router (`/auth/tesla/*`, not GraphQL) that walks the user through Tesla's OAuth redirect and stores per-vehicle access/refresh token pairs in `vehicle_tokens`. Never becomes a login method.

Shared Tesla token logic (exchange, refresh, authenticated fetch) lives in the `tesla-client` workspace package so `backend` (linking) and `worker` (polling) don't duplicate it.

## Key files and their role

**Backend — session auth**
- `backend/src/auth/jwt.js` — `signToken`/`verifyToken`. `verifyToken` swallows every failure mode (missing/malformed/wrong-signature/expired) into a single `null` return — callers can't distinguish "expired" from "tampered."
- `backend/src/auth/cookie.js` — sets/reads/clears the `session` cookie (`httpOnly`, `secure` in prod only, `sameSite: "lax"`, 30d `maxAge`).
- `backend/src/auth/password.js` — thin bcrypt wrapper (`hash(plain, 10)` / `compare`), nothing custom.
- `backend/src/demo/context.js` — `buildContext(req, res)`, wired into Apollo as the per-request `context` fn in `backend/src/index.js`. Resolves `{ db, user, isDemo, res }` from the cookie; falls back to a seeded demo account (`DEMO_EMAIL = "demo@tesla-fleet-dashboard.dev"`) when `DEMO_MODE_ENABLED=true` and no session cookie resolves a user. `res` is threaded through so `login`/`register`/`logout` mutations can set/clear the cookie on the same response Apollo sends.
- `backend/src/graphql/resolvers/helpers.js` — `requireUser` (throws `UNAUTHENTICATED`) and `requireOwnedVehicle` (throws `NOT_FOUND` for both "doesn't exist" and "not yours" — deliberate, comment in file explains it's to avoid leaking ownership via error type).
- `backend/src/graphql/resolvers/mutation.js` — `login`, `register`, `logout`, `refreshVehicle`. `login`/`register` both end in `signToken` + `setSessionCookie`. `register` explicitly blocks registering the reserved demo email with the *same* error message as a genuine duplicate.
- `backend/src/graphql/resolvers/types.js` — `User.isDemo` resolver is `user.email === DEMO_EMAIL`, computed per-resolved-user rather than read off `ctx.isDemo` — comment notes this is because `ctx` is built once before any mutation in the same request runs, so it can't reflect a user a `login`/`register` mutation just resolved.
- `backend/src/db/queries/users.js` — `getUserById`, `getUserByEmail` (includes `password_hash`), `createUser`.

**Backend — Tesla OAuth linking**
- `backend/src/routes/teslaAuth.js` — `GET /tesla/login` (requires session cookie, mints a 10-minute JWT as the OAuth `state`, redirects to Tesla) and `GET /tesla/callback` (verifies `state`, exchanges code, fetches the Tesla account's vehicles, upserts `vehicles`/`vehicle_tokens`, redirects into the SPA with `?linked=1` or `?linkError=...`). Every step failure is a redirect, never a JSON error body.
- `backend/src/db/queries/vehicles.js` — `getVehicleByTeslaVehicleId`, `insertVehicle` (`ON CONFLICT (vin) DO NOTHING` + re-select fallback — a VIN already linked to another dashboard user is a no-op on `vehicles`, keeps its original `user_id`).
- `backend/src/db/queries/tokens.js` — `insertVehicleTokens`, upsert on `vehicle_id` (`ON CONFLICT (vehicle_id) DO UPDATE`).
- `backend/migrations/001_init.sql` — `users`, `vehicles` (`ON DELETE CASCADE` from `users`), `vehicle_tokens` (PK = `vehicle_id`, `ON DELETE CASCADE` from `vehicles`). No later migration touches these three tables.

**Shared package**
- `packages/tesla-client/src/oauth.js` — `exchangeAuthCode` (one-time code→token exchange, used only in the callback before any `vehicle_tokens` row exists) and `ensureFreshToken` (reads the stored token, refreshes if within 5 minutes of `expires_at`, and — notably — rotates by `UPDATE ... WHERE refresh_token = $stale`, not `WHERE vehicle_id = $id`, because Tesla issues one refresh token per *account* and rotates it on every use; a refresh triggered by one vehicle must update every sibling vehicle still holding that same stale refresh token or they'd all break on next use).
- `packages/tesla-client/src/client.js` — `createTeslaClient(db, teslaConfig)` wraps `ensureFreshToken` + `fetch` into `getVehicleState`/`getVehicleLite`/`wakeVehicle`; also `fetchTeslaVehicles(accessToken, teslaConfig)` used once, right after `exchangeAuthCode`, with the raw not-yet-persisted access token.

**Frontend**
- `frontend/src/auth/AuthContext.jsx` — `ME_QUERY` with `fetchPolicy: "network-only"` is the sole source of auth state (`user` = `data?.me`); `login`/`register`/`logout` all `await` the mutation then `refetch()` — no local state mutation, session truth always comes from the server round-trip.
- `frontend/src/auth/LoginPage.jsx` — one component serves both `/login` and `/register` via a `register` prop; errors are just `err.message` from Apollo shown in an `Alert`.
- `frontend/src/App.jsx` — gates all routes on `auth.user`: unauthenticated → only `/login`/`/register` reachable (any other path also renders `LoginPage`); authenticated → full route tree under `Layout`.
- `frontend/src/components/Layout.jsx` / `frontend/src/pages/VehiclesPage.jsx` — "Link Tesla Account" is a plain `<Button component="a" href="/auth/tesla/login">`, i.e. a real browser navigation, not an Apollo call — required since the flow ends with Tesla issuing an inbound redirect the SPA can't intercept as a fetch response. Hidden entirely when `auth.user.isDemo`. `VehiclesPage` reads `?linked=1` / `?linkError=...` from the URL (set by the backend's post-callback redirect) to show a one-time success/error banner.

## Notable decisions / gotchas for future maintainers

- **`verifyToken` collapses all failure modes to `null`.** No way to tell a caller "your token just expired" vs. "this is garbage" — by design, but if a future UX need ("your session expired, please log in again" vs. a generic redirect) comes up, this function needs to change, and every caller (`buildContext`, `teslaAuth.js` both routes) needs re-checking.
- **`state` param reuses the session JWT signer with a 10-minute TTL** instead of a server-side pending-link table. Stateless by design — expiry is enforced by `jwt.verify` itself, no cleanup job. Worth knowing: the OAuth callback does **not** re-check the dashboard session cookie at all — authorization is carried entirely by `state`. A user could complete the Tesla redirect from a different browser/device than the one that started `/tesla/login`, as long as they still have the `state` value (only really possible via the URL Tesla redirects, so low risk, but not literally tied to a browser session).
- **Refresh-token rotation is keyed by matching the old `refresh_token` value across rows**, not `vehicle_id`. This is an application-level invariant with no DB constraint enforcing it — a future schema change to `vehicle_tokens` or to the refresh query must preserve `WHERE refresh_token = $stale`, or sibling vehicles under one Tesla account will silently stop refreshing.
- **`vehicle_tokens` stores access/refresh tokens in plain text columns**, no field-level encryption. Flagged in the tech spec too; still true in code as of this read.
- **No unlink/revoke path anywhere.** `logout` only clears the dashboard session cookie; it never touches `vehicle_tokens`. A linked Tesla token stays valid and gets polled by the worker until it expires or Tesla itself invalidates it.
- **Re-linking an already-known VIN under a different dashboard user is a silent no-op on ownership** (`insertVehicle`'s `ON CONFLICT (vin) DO NOTHING`) — the vehicle keeps its original owner; only its token row gets refreshed. Not a bug per the tech spec's stated design, but easy to mistake for one if debugging "why didn't this vehicle move to the new account."
- **`refreshVehicle`'s rate limiter (`lastRefreshAt` Map) is in-memory, per-process** — not shared across backend replicas if the app is ever horizontally scaled. Fine for the current single-process deployment.
- **No password strength/format validation** in `register` — anything non-empty (enforced client-side only, via the `required` HTML attribute) is accepted; bcrypt handles arbitrary length input fine, but there's no server-side minimum-length or format check.
- **No CSRF middleware beyond `sameSite=lax`**, no login rate limiting, no account lockout — confirmed absent in code, not just undocumented.
- **`DEMO_EMAIL` is duplicated as a literal string** between `backend/src/demo/context.js` and `scripts/seed-demo-data.js`, marked with a `ponytail:` comment in `context.js` explaining it's intentionally not factored into shared config for one string used in two small scripts.

## Verification / test coverage

Ran both relevant suites read-only; all pass:

- `backend`: `npm test` → `node --test $(find src -name '*.test.js')`, **13/13 passing**.
  - `backend/src/auth/jwt.test.js` — `signToken`/`verifyToken` roundtrip, rejects a token signed with a different secret, rejects an expired token. Good coverage of the exact failure modes `verifyToken` silently collapses.
  - `backend/src/graphql/resolvers/helpers.test.js` — `requireOwnedVehicle`: owner succeeds, another user's vehicle → `NOT_FOUND`, no user in context → `UNAUTHENTICATED`. Covers the anti-enumeration behavior directly.
  - `backend/src/graphql/resolvers/types.test.js`, `backend/src/db/queries/telemetry.test.js` — not auth-related (efficiency calc, snapshot fallback logic), included in the same run.
- `packages/tesla-client`: `npm test` → **2/2 passing**, but both are for `units.js` (`toKm`) — **no tests exist for `oauth.js` (`exchangeAuthCode`, `ensureFreshToken`, including the sibling-vehicle refresh-token rotation) or `client.js` (`fetchTeslaVehicles`, `createTeslaClient`)**.

**Gaps — not covered by any test in the repo:**
- `backend/src/routes/teslaAuth.js` — no test file for either `/tesla/login` or `/tesla/callback` (state signing/verification, redirect targets, error-path redirects).
- `backend/src/graphql/resolvers/mutation.js` — `login`, `register`, `logout`, `refreshVehicle` (including its rate limiting and wake-up polling loop) have no test file.
- `backend/src/demo/context.js` — `buildContext`'s cookie→user resolution and demo-mode fallback path untested.
- `backend/src/db/queries/users.js`, `tokens.js`, `vehicles.js` — no unit tests (would need a DB or a fake pool like `helpers.test.js` uses).
- `packages/tesla-client/src/oauth.js` — the refresh-token rotation query (the subtle cross-row invariant called out above) has no regression test; this is the single highest-value gap given how easy it'd be to break silently.
- No frontend tests at all (`AuthContext.jsx`, `LoginPage.jsx`, `App.jsx`'s auth-gated routing, `Layout.jsx`'s demo-mode/link-button visibility) — confirmed no `*.test.jsx`/`*.spec.jsx` files anywhere in the repo.

This is a documentation-only pass — no code, test, or config files were created or modified.
