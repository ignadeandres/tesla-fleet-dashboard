# Business Requirements — Authentication

**Feature:** Dashboard session auth (JWT/httpOnly cookie) + Tesla account linking (OAuth)
**Status:** Already implemented and shipped. This document reconstructs requirements from the existing code; it does not propose new scope.
**Source reviewed:** `backend/src/auth/`, `backend/src/routes/teslaAuth.js`, `backend/src/graphql/resolvers/{mutation,query,helpers}.js`, `backend/src/demo/context.js`, `backend/src/graphql/schema.graphql`, `backend/src/db/queries/{users,tokens}.js`, `backend/migrations/001_init.sql`, `frontend/src/auth/`, `frontend/src/App.jsx`, `frontend/src/pages/VehiclesPage.jsx`, `frontend/src/graphql/queries/auth.js`, `docs/setup-tesla-api.md`, `docs/functional-spec.md`.

Note: "Demo mode" (public read-only seeded account, `DEMO_MODE_ENABLED`) is a separate, out-of-scope feature. It's mentioned only where its code intersects the auth path (e.g. the reserved demo email during registration).

---

## User Stories & Acceptance Criteria

### US-1 — Register a dashboard account
As a new user, I want to create an account with an email and password, so that I can access the dashboard and later link my Tesla vehicles.

- Given an email not already in the `users` table and not equal to the reserved demo account email, when I submit the register form, then a `users` row is created (password hashed with bcrypt, cost 10), a session cookie is set, and I land on `/`.
- Given an email that's already registered (or equals the demo account's email), when I submit register, then the mutation throws `"Email already registered"` (`BAD_USER_INPUT`), shown as an inline Alert, and no row is created.
- Email and password are required fields in the form (HTML5 `required`); no minimum length or complexity is enforced client- or server-side.
- Email uniqueness is enforced at the DB level (`email TEXT UNIQUE NOT NULL`).

### US-2 — Log in
As a returning user, I want to log in with my email and password, so that I can access my own vehicle data.

- Given correct credentials, when I submit login, then the `login` mutation verifies the bcrypt hash, sets the `session` cookie (httpOnly, `sameSite=lax`, `secure` in production, 30-day `maxAge`), and I land on `/`.
- Given an unknown email or a wrong password, the mutation throws the same message — `"Invalid email or password"` (`UNAUTHENTICATED`) — for both cases (no user-enumeration signal), shown as an inline Alert, and no cookie is set.

### US-3 — Stay logged in across visits
As a logged-in user, I want my session to persist across page reloads and browser restarts, so that I don't have to log in every time.

- On every app load, the frontend runs the `me` query (`fetchPolicy: network-only`); the backend resolves the `session` cookie's JWT and returns the user + their vehicles if the token is present and valid.
- The session JWT defaults to a 30-day expiry (`signToken` default). Once expired, `verifyToken` returns `null`, `me` resolves to `null`, and the app falls back to the login page.
- While `me` is in flight, the app shows a loading spinner instead of flashing the login page or protected content.

### US-4 — Log out
As a logged-in user, I want to log out, so that my session ends on this device.

- Clicking logout calls the `logout` mutation, which clears the `session` cookie server-side (`res.clearCookie`).
- The frontend refetches `me` after logout; it resolves to `null` and the UI reverts to the login page.
- Logout only clears the local dashboard cookie — it does not revoke the linked Tesla OAuth grant/tokens (see Out of Scope).

### US-5 — Route access is gated by auth state
As a visitor, I want unauthenticated access limited to login/register, and authenticated access to reach the app, so that vehicle data isn't reachable without logging in.

- If `me` is `null`, every route (including `/register`) renders `LoginPage`; no dashboard route (`/vehicles`, `/v/:vehicleId/...`) is reachable, regardless of URL typed.
- If `me` is non-null, the app renders only the authenticated route tree (Layout + vehicle pages); there is no dedicated `/login` route in that tree, so navigating to it falls through the catch-all and redirects to `/`.
- `/` redirects to the first linked vehicle's overview page if the user has one, otherwise to `/vehicles`.

### US-6 — Protected GraphQL operations reject unauthenticated requests
As the system, I want to reject data access when there's no valid session, so that vehicle data is never served without auth.

- `vehicle(id)` query and `refreshVehicle(id)` mutation both call `requireUser(ctx)`, which throws `"Not authenticated"` (`UNAUTHENTICATED`) when `ctx.user` is `null`.
- `me` is the one exception: it does not throw when unauthenticated — it returns `null`, which is what the frontend uses to decide whether to show the login page.

### US-7 — Users can only access their own vehicles
As a user, I want to be sure I can only see/act on vehicles I own, so that other users' data and vehicle actions are never exposed to me.

- `requireOwnedVehicle` loads the vehicle and checks `vehicle.userId === user.id`.
- If the vehicle doesn't exist, or exists but belongs to another user, the resolver throws `"Vehicle not found"` (`NOT_FOUND`) in both cases — deliberately not distinguishing "doesn't exist" from "not yours," so ownership isn't leaked via error type.
- Enforced on the `vehicle` query and the `refreshVehicle` mutation.

### US-8 — Initiate Tesla account linking
As a logged-in user, I want to start linking my Tesla account, so the backend/worker can pull my vehicle's data on my behalf.

- `GET /auth/tesla/login` requires a valid dashboard session cookie; if missing/invalid, it redirects to `/login?error=auth_required` and never reaches Tesla.
- If authenticated, it redirects (302) to Tesla's `/oauth2/v3/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid offline_access vehicle_device_data vehicle_location`, and a `state` value that is a signed JWT (10-minute expiry) encoding the dashboard user id — this both ties the callback back to the initiating user and acts as CSRF protection for the OAuth round-trip, without needing a server-side state store.
- The "Link Tesla Account" control on the Vehicles page is a plain `<a href="/auth/tesla/login">` (full page navigation, not an in-SPA GraphQL call), because Tesla's redirect can't target a GraphQL mutation.

### US-9 — Complete the Tesla OAuth callback and auto-provision vehicles
As a user who just approved Tesla's consent screen, I want my vehicle(s) automatically registered and my tokens stored, so that data collection can start without any manual steps.

- `GET /auth/tesla/callback` requires both `code` and a `state` that verifies as a valid, unexpired signed token; if either check fails, it redirects to `/vehicles?linkError=invalid_request` and writes nothing to the DB.
- On success: exchanges `code` for Tesla access/refresh tokens, fetches the account's vehicle list, and for each returned vehicle:
  - reuses the existing `vehicles` row if one already exists for that `teslaVehicleId`, otherwise creates one attributed to the user from `state` (vin, display name; `model` left `null`);
  - upserts the token pair + expiry into `vehicle_tokens` (`ON CONFLICT (vehicle_id) DO UPDATE`), so re-linking refreshes stored tokens rather than duplicating rows.
- Redirects to `/vehicles?linked=1` on success.
- On any exchange/API failure, logs the error server-side and redirects to `/vehicles?linkError=exchange_failed`; no partial-state detail is exposed to the user beyond the generic error code.

### US-10 — See link result feedback
As a user returning from the Tesla OAuth flow, I want to see whether linking succeeded or failed, so I know if I need to retry.

- Vehicles page reads the `linked` and `linkError` query params.
- `linked=1` shows a success Alert ("Vehicle linked.").
- `linkError=<code>` shows an error Alert ("Linking failed (`<code>`). Try again.") for either `invalid_request` or `exchange_failed`.

---

## Out of Scope (confirmed absent from the code)

- Password reset / forgot-password flow — no route, mutation, or email-sending code exists.
- Email verification of new accounts.
- Password strength/complexity rules — only "non-empty" is enforced (HTML5 `required`).
- Login rate limiting / brute-force lockout on the `login` mutation.
- Multi-factor authentication.
- "Log in with Tesla" as a dashboard sign-in method — Tesla OAuth exists solely to *link a vehicle*, not to authenticate into the dashboard itself; a dashboard account (email/password) is always required first.
- Multi-tenant organizations, roles, or admin/RBAC — schema has no role field; every account is symmetric.
- Unlinking a Tesla account or removing a vehicle — no route/mutation deletes a `vehicles` or `vehicle_tokens` row.
- Revoking the Tesla OAuth grant, or a "logout of Tesla" flow — dashboard logout only clears the local session cookie.
- CSRF protection beyond `sameSite=lax` on the session cookie and the signed OAuth `state` param — no dedicated CSRF middleware/token.
- Account deletion, email change, or password change mutations.
- Vehicle command/write scopes (`vehicle_cmds`) — only `vehicle_device_data` and `vehicle_location` are requested, matching `docs/functional-spec.md`.
- Demo mode itself (separate feature) — only its intersection with registration (blocking the reserved demo email) is covered here.

---

## Assumptions / Open Questions

- **No password policy anywhere.** Assumption: intentional for a self-hosted/portfolio project, not an oversight to silently "fix" — flagging because it's unusual for shipped auth.
- **No login throttling in-app.** Open question: is brute-force protection handled at the infra layer (reverse proxy/fail2ban) outside this repo, or genuinely absent end-to-end?
- **No server-side "logout everywhere."** A copied session JWT stays valid until its 30-day expiry even after cookie-clear logout. Assumption: acceptable given the single-user/self-hosted threat model.
- **`JWT_SECRET` rotation isn't handled in-app** — rotating it invalidates all sessions at once; this is an ops concern, not app behavior, so left out of these stories.
- **OAuth `state` TTL is 10 minutes.** If a user lingers on Tesla's consent screen past that, the callback fails with the generic `invalid_request` error — the UI doesn't distinguish "expired" from "tampered/forged" state.
- **Empty vehicle list on callback.** If the Tesla account being linked has zero vehicles, the loop does nothing and the callback still redirects with `linked=1` (a technical "success" with nothing linked). Open question: is silent success the intended UX here, or should this show a distinct message?
- **No re-authentication gate before linking.** Any authenticated session can immediately trigger `/auth/tesla/login`; there's no step-up/re-confirm-password check before starting the OAuth flow.

---

**Files reviewed for this document** (all read-only, none modified):
- `backend/src/auth/jwt.js`
- `backend/src/auth/cookie.js`
- `backend/src/auth/password.js`
- `backend/src/routes/teslaAuth.js`
- `backend/src/graphql/resolvers/mutation.js`
- `backend/src/graphql/resolvers/query.js`
- `backend/src/graphql/resolvers/helpers.js`
- `backend/src/graphql/schema.graphql`
- `backend/src/demo/context.js`
- `backend/src/db/queries/users.js`
- `backend/src/db/queries/tokens.js`
- `backend/migrations/001_init.sql`
- `frontend/src/auth/AuthContext.jsx`
- `frontend/src/auth/LoginPage.jsx`
- `frontend/src/App.jsx`
- `frontend/src/pages/VehiclesPage.jsx`
- `frontend/src/graphql/queries/auth.js`
- `docs/functional-spec.md` (background, unedited)
- `docs/setup-tesla-api.md` (background, unedited)
