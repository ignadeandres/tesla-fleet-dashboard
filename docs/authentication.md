# Authentication

Two independent mechanisms, both served by the `backend` Express process:

1. **Dashboard session auth** — email/password login against the `users` table, backed by a JWT stored in an httpOnly `session` cookie. Required for every GraphQL operation except `me`.
2. **Tesla OAuth account linking** — a plain HTTP (non-GraphQL) redirect flow that grants the backend/worker access to a user's Tesla vehicle data. It never becomes a dashboard login method — a dashboard account is always required first.

Source of truth for everything below: `backend/src/auth/{jwt,cookie,password}.js`, `backend/src/routes/teslaAuth.js`, `backend/src/graphql/resolvers/{mutation,query,helpers,types}.js`, `backend/src/graphql/schema.graphql`, `backend/src/demo/context.js`.

## GraphQL API

All requests go to `POST /graphql`. Auth state comes from the `session` cookie (see below), not from an `Authorization` header — there's no bearer-token auth path even though `login`/`register` return a `token` field.

### `me: User`

Returns the currently logged-in user, or `null` if there's no valid session. This is the only auth-related field that **never throws** — it's the mechanism the frontend uses to determine whether a session exists in the first place.

```graphql
query Me {
  me {
    id
    email
    isDemo
    vehicles { id vin displayName model }
  }
}
```

If `DEMO_MODE_ENABLED=true` and no session cookie resolves a real user, `me` falls back to a seeded read-only demo account (`demo@tesla-fleet-dashboard.dev`) instead of `null` — see `backend/src/demo/context.js`.

### `login(email: String!, password: String!): AuthPayload!`

```graphql
mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    token
    user { id email }
  }
}
```

- On success: sets the `session` cookie on the response and returns `{ token, user }`. `token` is the same JWT that was just set as the cookie — it's returned for completeness but nothing in this codebase's frontend consumes it; `AuthContext.jsx` re-fetches `me` after the mutation instead of reading `data.login.token`.
- On failure: throws `"Invalid email or password"` (`UNAUTHENTICATED`) for **both** an unknown email and a wrong password — same message, same code, no way to distinguish the two from the response.

### `register(email: String!, password: String!): AuthPayload!`

```graphql
mutation Register($email: String!, $password: String!) {
  register(email: $email, password: $password) {
    token
    user { id email }
  }
}
```

- Creates a `users` row (`bcrypt` hash, cost 10), sets the `session` cookie, returns `{ token, user }`. Same success shape as `login`.
- No password length/complexity/format validation server-side — any non-empty string is accepted (the frontend's `required` HTML attribute is the only gate).
- Throws `"Email already registered"` (`BAD_USER_INPUT`) if the email is already taken **or** if it's the reserved demo account email (`demo@tesla-fleet-dashboard.dev`) — both cases return the identical error, so you can't probe whether the demo email is "special."
- Email uniqueness is enforced by the DB (`users.email UNIQUE`), not just the app-level pre-check, so a race between two concurrent registrations with the same email can't both succeed.

### `logout: Boolean!`

```graphql
mutation Logout {
  logout
}
```

Clears the `session` cookie and always returns `true` — no error case exists. This is client-side only: it does not invalidate the JWT server-side (there's no revocation list), so a copied token stays valid elsewhere until its own expiry, and it does **not** touch any linked Tesla OAuth tokens (`vehicle_tokens` is untouched).

### `vehicle(id: ID!): Vehicle` and `refreshVehicle(id: ID!): TelemetrySnapshot!`

Not auth mutations themselves, but both are gated the same way and are the two operations that exercise the "protected operation" and "ownership" error paths:

- Both call `requireUser(ctx)` first → throws `"Not authenticated"` (`UNAUTHENTICATED`) if there's no session at all.
- Both then load the vehicle and check `vehicle.userId === ctx.user.id` → throws `"Vehicle not found"` (`NOT_FOUND`) if the vehicle doesn't exist **or** belongs to a different user. These two cases are deliberately collapsed into one error so the error type can't be used to enumerate other users' vehicle IDs.
- `refreshVehicle` additionally throws `"Not available in demo mode"` (`FORBIDDEN`) when `ctx.isDemo`, and `"Refresh rate-limited, try again shortly"` (`RATE_LIMITED`) if called again for the same vehicle within 60 seconds (in-memory `Map`, per backend process — not shared across replicas).

### Error code reference

| Code | Where | Message |
|---|---|---|
| `UNAUTHENTICATED` | `login` | "Invalid email or password" |
| `UNAUTHENTICATED` | `requireUser` (`vehicle`, `refreshVehicle`) | "Not authenticated" |
| `BAD_USER_INPUT` | `register` | "Email already registered" |
| `NOT_FOUND` | `requireOwnedVehicle` (`vehicle`, `refreshVehicle`) | "Vehicle not found" |
| `FORBIDDEN` | `refreshVehicle` | "Not available in demo mode" |
| `RATE_LIMITED` | `refreshVehicle` | "Refresh rate-limited, try again shortly" |
| `VEHICLE_UNREACHABLE` | `refreshVehicle` | "Vehicle did not wake up in time" |

## Tesla OAuth linking flow

Two plain Express routes, mounted at `/auth` (`backend/src/index.js`) — **not** GraphQL, because the flow's middle step is a 302 to `auth.tesla.com` and its end step is Tesla redirecting the browser back to a URL of the backend's choosing. Neither is expressible as a mutation response. On the frontend this is a real `<a href="/auth/tesla/login">` browser navigation (`frontend/src/pages/VehiclesPage.jsx`), not a `fetch`/Apollo call — and it's hidden entirely when `auth.user.isDemo`.

### `GET /auth/tesla/login`

Starts the flow. Requires a valid `session` cookie (read directly via `readSessionCookie`/`verifyToken`, not through GraphQL context).

| Outcome | Response |
|---|---|
| No/invalid session | `302` → `/login?error=auth_required` (Tesla is never contacted) |
| Valid session | `302` → `https://auth.tesla.com/oauth2/v3/authorize?...` |

On success, the redirect to Tesla carries:

- `client_id`, `redirect_uri` — from `TESLA_CLIENT_ID` / `TESLA_REDIRECT_URI`
- `response_type=code`
- `scope=openid offline_access vehicle_device_data vehicle_location`
- `state=<signed JWT>` — `signToken(userId, "10m")`, i.e. the **same signer** used for session cookies, just a 10-minute TTL instead of 30 days.

**What `state` carries and why:** it encodes the dashboard user id and is self-verifying (`jwt.verify`), so there's no server-side "pending link" table to write, expire, or clean up. It does two jobs at once: tells the callback which dashboard user to attribute vehicles to, and acts as CSRF protection — only a `state` this server signed will pass `verifyToken`. Note the callback does **not** separately re-check the caller's session cookie; authorization on the callback leg is carried entirely by `state`.

### `GET /auth/tesla/callback`

Tesla redirects here with `?code=...&state=...` after the user approves (or denies) consent.

| Outcome | Response | DB writes |
|---|---|---|
| Missing `code`, or `state` missing/invalid/expired | `302` → `/vehicles?linkError=invalid_request` | none |
| `code`/`state` valid, token exchange or vehicle fetch throws | `302` → `/vehicles?linkError=exchange_failed` (error logged server-side via `console.error`, no detail sent to the browser) | none guaranteed — the whole per-vehicle loop is one try/catch, so vehicles already processed before the failure may have been written |
| Success | `302` → `/vehicles?linked=1` | see below |

On success, for each vehicle Tesla's account returns:

- Look up an existing `vehicles` row by `tesla_vehicle_id`. If none, insert one attributed to the `state`-derived user (`vin`, `display_name`; `model` is always `null` — Tesla's vehicle-list endpoint doesn't return it at link time).
- **If a row already exists (e.g. previously linked by a different dashboard user), it is reused as-is — not reattributed.** Re-linking an already-known VIN under a different account is a silent no-op on ownership; only that vehicle's token row gets refreshed. This is deliberate (`insertVehicle` uses `ON CONFLICT (vin) DO NOTHING`), not a bug, but easy to mistake for one while debugging "why didn't this vehicle move accounts."
- Always upsert `vehicle_tokens` for that vehicle (`ON CONFLICT (vehicle_id) DO UPDATE`) with the freshly exchanged access/refresh token pair and expiry — so re-linking the same Tesla account refreshes credentials without duplicating rows.

If the Tesla account has zero vehicles, the loop does nothing and the callback still redirects with `linked=1` — a technically "successful" link with nothing added.

Neither endpoint ever returns a JSON body; every outcome is communicated purely via the redirect destination and its query string. The Vehicles page (`frontend/src/pages/VehiclesPage.jsx`) reads `linked` / `linkError` off the URL to show a one-time success/error `Alert` — `linkError` values are rendered verbatim (`Linking failed ({code}). Try again.`), there's no friendlier copy mapping per code.

## Session cookie

Set by `setSessionCookie` (`backend/src/auth/cookie.js`), called from `login`/`register`. Cleared by `clearSessionCookie`, called from `logout`.

| Property | Value |
|---|---|
| Name | `session` |
| Contents | JWT, `{ sub: userId }`, HS256, signed with `JWT_SECRET` |
| `httpOnly` | `true` (unreachable from JS — mitigates XSS token theft) |
| `secure` | `true` only when `NODE_ENV === "production"` (allows plain HTTP in local/dev Docker Compose) |
| `sameSite` | `"lax"` (blocks cross-site POST-based CSRF, still allows the top-level navigation the Tesla redirect performs) |
| `maxAge` | 30 days (`2_592_000_000` ms) — matches `signToken`'s default `expiresIn`, so the cookie doesn't outlive or undershoot the token inside it |

`verifyToken` (`backend/src/auth/jwt.js`) collapses every failure mode — missing, malformed, wrong signature, expired — into a single `null` return. Callers (`buildContext`, both `teslaAuth.js` routes) can't distinguish "your session expired" from "this token is garbage"; there's no distinct expired-session UX anywhere in the app, it just falls back to the login page.

There is no server-side session store or revocation list. `logout` only clears the cookie on the browser that called it — a copied/exported token remains valid on any other client until its own 30-day expiry.

## Gotchas for anyone extending this

- **`AuthPayload.token` is dead weight in the current frontend.** The schema and mutations return it, but `AuthContext.jsx` ignores it and relies entirely on the cookie + a `me` refetch. If you're integrating a non-browser client that needs bearer-token auth, note that `ctx.user` on every subsequent request is resolved from the cookie only — sending `Authorization: Bearer <token>` today does nothing; you'd need to add header-based context resolution yourself.
- **The OAuth callback trusts `state` alone**, not the caller's dashboard session. A user could technically complete `/auth/tesla/callback` from a different browser/device than the one that started `/auth/tesla/login`, as long as they have the `state` value — realistically only reachable via Tesla's own redirect URL, so low risk, but worth knowing if you're reasoning about the trust boundary.
- **`vehicle_tokens` stores Tesla access/refresh tokens in plain text columns**, no field-level encryption. Treat it and `JWT_SECRET`/`TESLA_CLIENT_SECRET` as the highest-sensitivity data in this system.
- **No unlink/revoke path exists.** Nothing deletes a `vehicles` or `vehicle_tokens` row, and `logout` doesn't touch them — a linked Tesla token stays valid and gets polled by the worker until Tesla itself invalidates it.
- **No CSRF middleware beyond `sameSite=lax`**, no login rate limiting/lockout, no password policy beyond non-empty — all confirmed absent in code as of this doc, not just unimplemented on paper.
