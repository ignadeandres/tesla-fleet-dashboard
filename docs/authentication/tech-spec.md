# Tech Spec — Authentication

**Feature:** Dashboard session auth (JWT/httpOnly cookie) + Tesla account linking (OAuth)
**Status:** Already implemented and shipped. Grounded in `docs/authentication/functional-spec.md`.

## Architecture

### Component boundaries and data flow

```
Browser (React SPA)
  │
  ├─ GraphQL over HTTPS (login/register/logout/me/vehicle/refreshVehicle)
  │      cookie: "session" (httpOnly JWT) sent automatically
  │      ▼
  │  backend/src/index.js — single Express process
  │      ├─ cookie-parser middleware (all routes)
  │      ├─ /graphql  → Apollo Server, per-request context = buildContext(req, res)
  │      └─ /auth      → teslaAuthRouter (plain Express, not Apollo)
  │
  └─ Full-page browser navigation (NOT a fetch/XHR)
         GET /auth/tesla/login  → 302 → Tesla /oauth2/v3/authorize
         Tesla                  → 302 → GET /auth/tesla/callback?code&state
         backend                → 302 → back into the SPA at /vehicles?linked=1|linkError=...

Shared package: packages/tesla-client (npm workspace)
  - imported by both backend (teslaAuth.js, mutation.js) and worker (poller.js, handlers/*)
  - owns: exchangeAuthCode, ensureFreshToken (refresh + DB update), createTeslaClient (authenticated fetch wrapper)
  - single source of truth for "how to talk to Tesla's auth/API servers" so the backend
    (OAuth linking) and the worker (background polling) never duplicate token logic
```

Two independent identity mechanisms exist in this system, deliberately kept separate:

1. **Dashboard session auth** — who is logged into *this app* (email/password, `users` table, JWT cookie). Governs every GraphQL operation.
2. **Tesla OAuth linking** — a one-time, per-vehicle grant of Tesla API access, stored as an access/refresh token pair per `vehicles` row in `vehicle_tokens`. It never becomes a dashboard login method; it only authorizes the worker/backend to call Tesla's API on the user's behalf. `docs/authentication/business-requirements.md` confirms "Log in with Tesla" was never in scope.

### Dashboard session auth (JWT + httpOnly cookie)

**Signing/verification** — `backend/src/auth/jwt.js` wraps `jsonwebtoken`: `signToken(userId, expiresIn="30d")` signs `{ sub: userId }` with `JWT_SECRET` (HMAC, library default `HS256`); `verifyToken(token)` returns the `sub` claim or `null` on any failure (missing, malformed, wrong signature, expired) — callers never see a distinct "expired" vs "invalid" case, by design (`try { jwt.verify } catch { return null }`).

**Cookie config** — `backend/src/auth/cookie.js` sets a single cookie named `session`: `httpOnly` (unreachable from JS, blocks XSS token theft), `secure` gated on `NODE_ENV === "production"` (allows plain HTTP in local/dev Docker Compose), `sameSite: "lax"` (blocks cross-site POST-based CSRF while still allowing the top-level navigation the Tesla OAuth redirect performs), `maxAge` = 30 days, matching `signToken`'s default expiry so the cookie doesn't outlive or undershoot the token it holds.

**Where auth attaches to GraphQL requests** — `backend/src/index.js` wires Apollo's `context` function to `buildContext(req, res)` (`backend/src/demo/context.js`), invoked fresh on every `/graphql` request. It reads `req.cookies.session` via `readSessionCookie`, verifies it, and if valid, loads `{ id, email }` from `users` by id and returns `{ db, user, isDemo, res }` as the resolver context — `res` is threaded through specifically so `login`/`register`/`logout` mutations can call `setSessionCookie`/`clearSessionCookie` on the same response Apollo is about to send. If there's no valid token, `user` is `null` (not an error) unless `DEMO_MODE_ENABLED` and a seeded demo account exists, in which case that account is used as a read-only fallback identity (`isDemo: true`, keyed off the account's email so it applies whether reached anonymously or via its own published login). Every resolver that needs auth calls `requireUser(ctx)` (`backend/src/graphql/resolvers/helpers.js`), which throws `UNAUTHENTICATED` if `ctx.user` is null; `me` is the sole resolver that reads `ctx.user` directly without requiring it, since it's the mechanism the frontend uses to *determine* auth state. Vehicle ownership (`requireOwnedVehicle`) collapses "vehicle doesn't exist" and "vehicle belongs to someone else" into the same `NOT_FOUND` error, so the error type can't be used to enumerate other users' vehicle IDs.

Passwords: `backend/src/auth/password.js` — `bcrypt.hash(plain, 10)` / `bcrypt.compare`. Nothing novel here — standard bcrypt at a standard cost factor, no custom hashing.

### Tesla OAuth account linking

**Why a separate Express route instead of a GraphQL mutation** — the flow's midpoint is a redirect to `auth.tesla.com`, a third party the app doesn't control, and the flow ends with Tesla redirecting the *browser* back to a URL of the backend's choosing. Neither step is expressible as a GraphQL operation: a mutation returns JSON to a fetch call, it cannot issue an HTTP 302 that repoints the browser at another origin, and it cannot receive an inbound redirect from that origin either. `teslaAuthRouter` (`backend/src/routes/teslaAuth.js`) is mounted at `/auth` in `backend/src/index.js`, alongside but independent of the `/graphql` mount — same Express app, same process, different endpoint style because the transport requirements are different, not because of a layering preference. On the frontend this surfaces as a plain `<a href="/auth/tesla/login">` (full page navigation) rather than an Apollo mutation call, confirmed in `functional-spec.md` and the Vehicles page.

**Why the signed `state` param substitutes for server-side session storage** — `GET /tesla/login` first requires a valid dashboard session cookie (reusing `verifyToken`/`readSessionCookie`, the same primitives GraphQL context uses); if that's missing, Tesla is never contacted at all. If present, it mints `state = signToken(userId, "10m")` — the *same* JWT signer used for session cookies, just with a short TTL and the OAuth `state` slot as the transport instead of a cookie. This does two jobs Tesla's OAuth flow otherwise needs a server-side "pending link" record for: (1) it tells the callback which dashboard user to attribute the linked vehicle(s) to, and (2) it's CSRF protection — only a `state` this server signed will verify, so a forged callback hit with an attacker's own `code` can't be walked through as if a real user initiated it. The alternative would be a DB-backed pending-authorization table (row per initiated link, looked up by an opaque id in `state`, expired by a cron or a `WHERE expires_at > now()` check) — that's more moving parts (a table, a cleanup path, a write on every login attempt including ones that never complete) to get properties a signed, self-expiring token already gives for free: expiry is enforced by `jwt.verify` itself, no cleanup job needed, and no extra DB round-trip on either leg of the flow. Given the flow is inherently single-use and short-lived (10 minutes to complete a redirect round-trip), a stateless signed token is the smaller design, not a shortcut around a "real" one.

**Callback processing** (`GET /tesla/callback`, `backend/src/routes/teslaAuth.js`) — requires both `code` and a `state` that verifies; either failing means no Tesla call and no DB write (`invalid_request`). On success it calls `exchangeAuthCode` and `fetchTeslaVehicles` from `tesla-client`, then per Tesla vehicle: reuses an existing `vehicles` row by `tesla_vehicle_id` if one exists (does not reattribute it to the current user — see rationale below), otherwise inserts a new one attributed to the `state`-derived `userId`; either way it upserts `vehicle_tokens` (`ON CONFLICT (vehicle_id) DO UPDATE`), so re-linking refreshes credentials rather than duplicating rows. Any exception (bad code, Tesla API error) is caught, logged server-side only, and surfaces to the browser as the generic `exchange_failed` code — no stack trace or partial-progress detail leaves the server.

**Why it relies on `packages/tesla-client`** — token exchange (`exchangeAuthCode`), refresh (`ensureFreshToken`), and authenticated Tesla API calls (`createTeslaClient`) live in the shared workspace package, not duplicated in `backend`. The `worker` process (`worker/src/poller.js` and its handlers) also imports the same package to poll vehicle state on a schedule using the tokens this OAuth flow stores. Given npm workspaces are already the project's mechanism for code sharing between `backend` and `worker`, putting Tesla-specific HTTP/token logic in `packages/tesla-client` reuses that existing boundary rather than introducing a new one (e.g. an internal HTTP call between backend and worker, or copy-pasted token-refresh code in two places) — notably `ensureFreshToken`'s refresh-token rotation (`UPDATE ... WHERE refresh_token = $4`, updating every vehicle row sharing that account-level refresh token) is exactly the kind of logic that would silently drift out of sync if it existed in two copies.

**Vehicle/token data ownership** — one `vehicles` row per Tesla vehicle (unique on VIN), one `vehicle_tokens` row per vehicle (`ON CONFLICT (vehicle_id)`), not per dashboard user. Tesla issues one refresh token per Tesla *account*, rotated on every use, so token storage is keyed to the vehicle it authorizes, and a refresh triggered by polling one vehicle updates the stored token on every sibling vehicle still holding the now-stale refresh token (`packages/tesla-client/src/oauth.js`). This is a data-boundary point worth flagging for security review: `vehicle_tokens` holds live Tesla access/refresh tokens in plain columns (no field-level encryption observed in `insertVehicleTokens`), and there is no unlink/revoke path — logout does not touch `vehicle_tokens`, and a Tesla token remains valid and polled until it expires or fails at Tesla's end, per `business-requirements.md`'s Out-of-Scope list.

### Rationale summary (ADR-style, as implemented)

- **JWT + httpOnly cookie vs. server-side session store** — no `sessions` table, no Redis, nothing beyond the `users` table. Verification is self-contained (`jwt.verify` needs only `JWT_SECRET`, no DB round-trip), which matches a single backend process with no separate session-store dependency already running in this stack. Cost accepted: no server-side revocation (`logout` only clears the client's cookie; a copied token stays valid until its own 30-day expiry) — acceptable given the documented single-user/self-hosted threat model, not an oversight.
- **`state` param carrying the signed user id vs. a DB-backed pending-link table** — covered above; the signed-token approach reuses the JWT signer already in the codebase (`jwt.js`) instead of adding a table, an expiry-cleanup mechanism, and a lookup query for a record that exists for at most 10 minutes and is read exactly once.
- **Separate Express route vs. GraphQL mutation for OAuth** — dictated by transport, not preference: GraphQL mutations can't issue a 302 to a third-party origin or receive Tesla's inbound redirect. Both mount points share the same Express app and process, so this isn't a service split, just two endpoint styles under one deployable.
- **Tesla token/API logic centralized in `packages/tesla-client` vs. duplicated in backend and worker** — reuses the existing npm-workspaces boundary already used to share code between `backend` and `worker`; avoids two copies of refresh-token rotation logic that must stay behaviorally identical (rotation touches every vehicle sharing an account-level refresh token).
- **Identical "not authenticated"/"vehicle not found" error shapes regardless of true cause** — deliberate anti-enumeration measure (login: same message for unknown-email vs. wrong-password; vehicle access: same `NOT_FOUND` for nonexistent vs. not-yours) rather than more granular error codes that would leak which case applied.

### Security/data-boundary notes for handoff

- `vehicle_tokens` stores Tesla access/refresh tokens unencrypted at the column level; treat `vehicle_tokens` and `JWT_SECRET`/`TESLA_CLIENT_SECRET` as the two highest-sensitivity assets in this system.
- No CSRF middleware beyond `sameSite=lax` + the signed OAuth `state`; no rate limiting on `login`; no account lockout — all confirmed absent in code, not just undocumented.
- Refresh-token rotation is account-scoped and updates all sibling vehicle rows by matching the old `refresh_token` value — a subtle invariant a future change to `vehicle_tokens`' schema or the refresh query must preserve.

## Data & API Design

### 1. Domain model

**Entities**

- **User** — a dashboard account. Authenticates with email + bcrypt password hash. One well-known row (`email = demo@tesla-fleet-dashboard.dev`, see `backend/src/demo/context.js`) is the read-only demo account; `isDemo` is derived from this email match, not a stored column.
- **Vehicle** — a physical Tesla vehicle known to the dashboard, identified by Tesla's own `id` (`tesla_vehicle_id`) and `vin`. Owned by exactly one `User` (`user_id`, nullable at the schema level but always set by the only code path that inserts vehicles — the OAuth callback). A vehicle is created once, on first link, and reused on subsequent re-links (lookup by `tesla_vehicle_id`).
- **VehicleToken** — the Tesla Fleet API OAuth token pair for one `Vehicle`. One row per vehicle (not per user, not per Tesla account), keyed by `vehicle_id` as primary key. Populated/refreshed by `insertVehicleTokens` (upsert) at link time and by `packages/tesla-client`'s refresh flow afterward.

**Relationships**

```
User (1) ──< (N) Vehicle (1) ──1:1── VehicleToken
```

- `users.id` ← `vehicles.user_id` (`ON DELETE CASCADE`): deleting a user deletes their vehicles.
- `vehicles.id` ← `vehicle_tokens.vehicle_id` (`ON DELETE CASCADE`, and also the PK of `vehicle_tokens`): deleting a vehicle deletes its token row; a vehicle can have at most one token row.

**Invariant not visible in the schema, worth noting for implementers:** several `vehicle_tokens` rows can share the same `refresh_token` value (multiple vehicles authorized under one Tesla account login produce the same refresh token at grant time). Rotation therefore updates `WHERE refresh_token = $stale` rather than `WHERE vehicle_id = $id` (`packages/tesla-client/src/oauth.js:58`), so all sibling vehicles' tokens stay in sync. This is enforced entirely in application code — there is no DB constraint tying rows with equal `refresh_token` together.

### 2. Database schema

Source: `backend/migrations/001_init.sql`. No later migration (`002_telemetry.sql` … `006_api_call_budget.sql`) alters `users`, `vehicles`, or `vehicle_tokens`; they only add FK references *to* `vehicles.id`.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vehicles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  tesla_vehicle_id BIGINT UNIQUE NOT NULL,
  vin              TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  model            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vehicle_tokens (
  vehicle_id    UUID PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);
```

Notes on constraints as implemented:
- `users.email` unique — enforces one account per email; `register` also does an app-level pre-check (`getUserByEmail`) before insert, so the DB constraint is the backstop for the race, not the primary check.
- `vehicles.tesla_vehicle_id` and `vehicles.vin` are both unique — a given Tesla vehicle can only ever map to one `vehicles` row, regardless of which dashboard user links it. `insertVehicle` uses `ON CONFLICT (vin) DO NOTHING` + fallback re-select, i.e. relinking an already-known VIN under a *different* dashboard user is a no-op on `vehicles` (the row keeps its original `user_id`); only its `vehicle_tokens` row gets upserted with the new tokens.
- `vehicles.user_id` has no `NOT NULL` — schema allows an orphaned vehicle, though no code path currently produces one.
- No explicit indexes beyond the PK/UNIQUE-backed ones (Postgres auto-creates a btree index for each `UNIQUE`/`PRIMARY KEY`). No additional index on `vehicles.user_id` despite it being the FK used by `getVehiclesByUserId`'s `WHERE user_id = $1`.
- `model` and `display_name` are nullable; the OAuth callback always inserts `model: null` (Tesla's vehicle-list API doesn't return it at link time) and whatever `display_name` Tesla returns (may be null/empty).

### 3. API design

#### 3.1 GraphQL — types

Source: `backend/src/graphql/schema.graphql`.

```graphql
type User {
  id: ID!
  email: String!
  isDemo: Boolean!
  vehicles: [Vehicle!]!
}

type AuthPayload {
  token: String!
  user: User!
}
```

- `User.isDemo` is a computed field resolver (`User.email === DEMO_EMAIL`), not a column — see `backend/src/graphql/resolvers/types.js`.
- `User.vehicles` resolver: `getVehiclesByUserId(ctx.db, user.id)` — all vehicles owned by that user, ordered by `created_at`.
- `AuthPayload.token` is the same signed JWT that's also set as the httpOnly session cookie; it's returned in the payload for clients that need it outside cookie flow, but the session itself is cookie-driven (`ctx.user` on every subsequent request comes from the cookie, not from a header).
- `Vehicle` type carries no token/OAuth fields — `vehicle_tokens` is never exposed over GraphQL.

#### 3.2 GraphQL — queries

```graphql
type Query {
  me: User
  vehicle(id: ID!): Vehicle
}
```

| Query | Resolver | Behavior | Errors |
|---|---|---|---|
| `me` | `query.js: (_, __, ctx) => ctx.user` | Returns the session user (from `buildContext`) or `null` if unauthenticated and demo mode is off. Never throws — `null` is the "not logged in" signal. | none |
| `vehicle(id)` | `requireOwnedVehicle(ctx, id)` (`helpers.js`) | Looks up the vehicle by id and checks `vehicle.userId === ctx.user.id`. | `UNAUTHENTICATED` ("Not authenticated") if no session user at all. `NOT_FOUND` ("Vehicle not found") both when the vehicle doesn't exist **and** when it belongs to another user — deliberately not `FORBIDDEN`, so ownership isn't leaked (see comment in `helpers.js`). |

#### 3.3 GraphQL — mutations

```graphql
type Mutation {
  login(email: String!, password: String!): AuthPayload!
  register(email: String!, password: String!): AuthPayload!
  logout: Boolean!
  refreshVehicle(id: ID!): TelemetrySnapshot!
}
```

| Mutation | Behavior | Success | Errors |
|---|---|---|---|
| `login` | `getUserByEmail` → `bcrypt.compare` → `signToken(user.id)` (30d default expiry) → `setSessionCookie` (httpOnly, `secure` in prod, `sameSite=lax`, 30d maxAge). | `AuthPayload{ token, user: { id, email } }` | `UNAUTHENTICATED` ("Invalid email or password") for both unknown email and wrong password (no distinction, avoids user enumeration). |
| `register` | Rejects the reserved demo email outright; else checks `getUserByEmail` for a duplicate, `bcrypt.hash(password, 10)`, `createUser`, then same token+cookie issuance as `login`. No password strength/format validation in code. | `AuthPayload{ token, user }` | `BAD_USER_INPUT` ("Email already registered") — same message/code for the demo-email case and a genuine duplicate. |
| `logout` | `clearSessionCookie(ctx.res)` — clears the `session` cookie. Stateless; no server-side token invalidation (JWTs simply stop being sent). | `true` (always) | none |
| `refreshVehicle(id)` | Requires ownership via `requireOwnedVehicle`. Rate-limited to 1 call per vehicle per 60s via an in-memory `Map` (per backend process — not shared across instances). Fetches a lightweight vehicle state; if `asleep`, sends a wake command and polls up to 5×3s. On success, fetches full vehicle state, inserts a `TelemetrySnapshot`, and returns the latest snapshot row. | `TelemetrySnapshot!` | `FORBIDDEN` ("Not available in demo mode") if `ctx.isDemo`. `UNAUTHENTICATED`/`NOT_FOUND` via `requireOwnedVehicle` (see above). `RATE_LIMITED` ("Refresh rate-limited, try again shortly") if called again within 60s for the same vehicle. `VEHICLE_UNREACHABLE` ("Vehicle did not wake up in time") if still asleep after 5 wake-poll attempts. |

Vehicle *linking* (creating the `Vehicle`/`VehicleToken` rows) is intentionally **not** a GraphQL mutation — see the comment in `schema.graphql` — because Tesla's OAuth redirect must land on a plain HTTP URL, not a GraphQL operation. That's handled by the REST-style router below.

#### 3.4 REST-style OAuth endpoints

Source: `backend/src/routes/teslaAuth.js`, mounted at `/auth` (`backend/src/index.js`).

**`GET /auth/tesla/login`**

- Auth: reads the `session` cookie directly (not via GraphQL context) and `verifyToken`s it to get `userId`.
- Query params in: none.
- Behavior:
  - No valid session → `302` redirect to `/login?error=auth_required`.
  - Valid session → signs a **10-minute** JWT (`signToken(userId, "10m")`) used as the OAuth `state` param (this is the "signed short-lived JWT instead of server-side pending-link storage" referenced in the architecture), then `302` redirects to Tesla's authorize URL:
    - `https://auth.tesla.com/oauth2/v3/authorize` (or `TESLA_AUTH_BASE` override — note: this constant, unlike `teslaConfig.authBase` used for token exchange, is not env-overridable in this file)
    - query params set: `client_id`, `redirect_uri` (`TESLA_REDIRECT_URI`), `response_type=code`, `scope=openid offline_access vehicle_device_data vehicle_location`, `state=<signed JWT>`.

**`GET /auth/tesla/callback`**

- Query params in: `code`, `state` (both set by Tesla's redirect).
- Behavior:
  - `state` verified via `verifyToken(state)` to recover `userId`. Missing `code` or invalid/expired/missing `state` → `302` redirect to `/vehicles?linkError=invalid_request`. (No dashboard-session check here — authorization is entirely carried by the `state` JWT, per the architecture's "signed state instead of pending-link storage" design.)
  - On valid input: `exchangeAuthCode(code, teslaConfig)` → `fetchTeslaVehicles(accessToken, teslaConfig)` → for each Tesla vehicle: look up by `tesla_vehicle_id`, `insertVehicle` if new (using `userId` from `state`, `tv.id`, `tv.vin`, `tv.display_name`, `model: null`), then always `insertVehicleTokens` (upsert on `vehicle_id`) with the freshly exchanged token pair. Every vehicle on the Tesla account gets/refreshes a token row, even ones already linked to another dashboard user.
  - Success → `302` redirect to `/vehicles?linked=1`.
  - Exchange/fetch failure (any thrown error) → logged server-side (`console.error`), `302` redirect to `/vehicles?linkError=exchange_failed`. No distinction between Tesla-side auth failure, network failure, or partial per-vehicle failure — the whole loop is wrapped in one try/catch.

No JSON response body on either endpoint in any case — both are pure redirect-driven flows, outcomes communicated only via the destination path + query string (`error=`, `linkError=`, `linked=1`).

**Files consulted** (read-only, not modified): `backend/src/auth/jwt.js`, `cookie.js`, `password.js`, `backend/src/routes/teslaAuth.js`, `backend/src/graphql/resolvers/{mutation,query,helpers,types}.js`, `backend/src/graphql/schema.graphql`, `backend/src/demo/context.js`, `backend/src/index.js`, `backend/src/db/queries/{users,tokens,vehicles}.js`, `backend/migrations/001_init.sql`, `packages/tesla-client/src/{oauth,client,index}.js`.
