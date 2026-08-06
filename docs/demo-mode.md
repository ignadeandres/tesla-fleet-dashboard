# Demo Mode

A public, read-only, seeded account (`demo@tesla-fleet-dashboard.dev`) for portfolio/CV
viewing, reachable with zero login step when enabled. It is not a separate code path — it's
a lower-priority fallback branch inside the same identity resolution every request already
goes through.

Source of truth: `backend/src/demo/context.js`, `scripts/seed-demo-data.js`,
`backend/src/graphql/resolvers/mutation.js`, `backend/src/graphql/resolvers/types.js`,
`backend/src/routes/teslaAuth.js`, `docker-compose.yml`.

## How it works

`buildContext(req, res)` (`backend/src/demo/context.js`) resolves `ctx.user`/`ctx.isDemo`
once per request, before any resolver runs, in this strict priority order:

```js
export async function buildContext(req, res) {
  const token = readSessionCookie(req);
  const userId = token ? verifyToken(token) : null;

  if (userId) {
    // 1. Valid session cookie -> real lookup by id. isDemo is derived from
    //    that row's email, so an explicit demo login lands here too.
    const { rows } = await db.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (rows[0]) return { db, user: rows[0], isDemo: rows[0].email === DEMO_EMAIL, res };
  }

  if (DEMO_MODE_ENABLED) {
    // 2. No/invalid cookie + demo mode on -> fall back to the seeded demo user.
    const id = await getDemoUserId();
    if (id) return { db, user: { id, email: DEMO_EMAIL }, isDemo: true, res };
  }

  // 3. Neither -> anonymous, unauthenticated.
  return { db, user: null, isDemo: false, res };
}
```

- **Priority 1 always wins.** A visitor who explicitly logs in with the published demo
  credentials (`demo@tesla-fleet-dashboard.dev` / `demo1234` — same `login` mutation as any
  real account, no demo-specific branch) resolves via branch 1, not branch 2. Both branches
  end up with `isDemo: true` for the same shared user id, so downstream code can't tell them
  apart — but *how* the session was reached differs, which matters for the security issue
  below.
- **`isDemo` is never stored** — not in the JWT, not in the cookie, not in a column. It's
  `user.email === DEMO_EMAIL`, recomputed in `buildContext` and again independently by the
  `User.isDemo` GraphQL field resolver (`backend/src/graphql/resolvers/types.js`):
  ```js
  isDemo: (user) => user.email === DEMO_EMAIL,
  ```
- **The demo user's id is cached in a module-level variable** (`demoUserId`) after the first
  lookup, not re-queried per request. This means a backend process restart is required for a
  change to `DEMO_MODE_ENABLED` or a manually-changed demo user id to take effect.
- **`DEMO_MODE_ENABLED` is a strict string match** against `"true"` — anything else (`"1"`,
  `"TRUE"`, unset, empty) disables the fallback.
- If demo mode is enabled but `seed:demo` was never run, branch 2 finds no row, falls through
  to branch 3, and the visitor just sees the normal login page — no error, no log line.

## Enabling and seeding

| Step | Where |
|---|---|
| Enable | `docker-compose.yml` — `DEMO_MODE_ENABLED: "true"` under the `backend` service. This is a **hardcoded literal**, not `${VAR}`-interpolated like the file's other settings — turning it off requires editing `docker-compose.yml` directly, not just `.env`. |
| Seed | `npm run seed:demo` (`scripts/seed-demo-data.js`), run manually from the host against the exposed Postgres port. Not run automatically by any service at startup or on a schedule. |

The seed script writes, in one transaction:

- 1 `users` row (bcrypt-hashed `demo1234`)
- 1 `vehicles` row (VIN `DEMOVIN0000000001`, "Demo Model 3")
- 673 `telemetry_snapshots` (7 days, 15-minute cadence, synthetic battery curve — charges
  02:00–06:00, drains otherwise, clamped 20–100%)
- 5 `trips` (16 `trip_points` each)
- 3 `charging_sessions`

It never inserts a `vehicle_tokens` row for the demo vehicle, which is also why the worker
(`worker/src/poller.js`, which polls via `INNER JOIN vehicle_tokens`) never touches it under
normal operation — the demo vehicle's data is static between reseeds.

**Idempotency boundary — read before re-running in a live environment:**

| Table | Safe to re-run? | Why |
|---|---|---|
| `users`, `vehicles` | Yes | `ON CONFLICT (email) / (vin) DO NOTHING`, then re-selected by key. Never duplicates the account/vehicle or rotates the password hash. |
| `telemetry_snapshots`, `trips`, `trip_points`, `charging_sessions` | **No** | No uniqueness constraint or conflict clause. Running `npm run seed:demo` a second time against an already-seeded database **appends** a second batch of time-series rows on top of the first rather than replacing it — the demo vehicle ends up with overlapping/duplicated history. |

## What's blocked for the demo account

`refreshVehicle` (`backend/src/graphql/resolvers/mutation.js`) is the **only** mutation with
any `isDemo` check in the entire schema:

```js
async function refreshVehicle(_, { id }, ctx) {
  if (ctx.isDemo) {
    throw new GraphQLError("Not available in demo mode", { extensions: { code: "FORBIDDEN" } });
  }
  const vehicle = await requireOwnedVehicle(ctx, id);
  // ...rate limit, wake-if-asleep, Tesla API call, snapshot insert
}
```

- Check runs first, before ownership is verified — a demo caller gets `FORBIDDEN` even for a
  vehicle it doesn't own, never `NOT_FOUND`.
- Applies identically whether `isDemo` came from the anonymous fallback or an explicit demo
  login — both produce `ctx.isDemo === true`.
- The frontend also hides the "Refresh Now" button when `me.isDemo`, but that's presentation
  only; the check above is what actually enforces it against a direct GraphQL call.
- `login`, `register`, and `logout` run unmodified for the demo account. `register` has its
  own separate block on ever *recreating* `demo@tesla-fleet-dashboard.dev` — see
  `docs/authentication.md`, not repeated here.
- "Link Tesla Account" is hidden in the UI (`Layout` header, `VehiclesPage`) when `me.isDemo`
  — but that's UI-only, with **no server-side equivalent**. See below.

Any new mutation that writes to a vehicle/account needs its own explicit `ctx.isDemo` check
— there is no shared guard or middleware that applies this automatically.

## Known Security Issue

**`GET /auth/tesla/login` has no `isDemo` check. A visitor who explicitly logs in with the
published demo credentials can link a real Tesla vehicle to the shared public demo account.**

Verified directly against `backend/src/routes/teslaAuth.js`:

```js
teslaAuthRouter.get("/tesla/login", (req, res) => {
  const userId = verifyToken(readSessionCookie(req));
  if (!userId) return res.redirect("/login?error=auth_required");
  // ...builds the Tesla OAuth authorize URL and redirects, no isDemo check anywhere
});
```

This route is a plain Express handler (mounted at `/auth` in `backend/src/index.js`) that
never calls `buildContext` — it reads the session cookie and verifies the JWT directly. Its
**only** check is "does this cookie resolve to *some* user id." It never inspects `isDemo` or
compares the resolved user's email to `demo@tesla-fleet-dashboard.dev`. "Link Tesla Account"
is hidden client-side (conditional rendering based on `me.isDemo`), but that is UI omission,
not access control — the route itself has no guard.

**Who can trigger it:**

- The purely anonymous fallback path (demo mode's branch 2, no real cookie) **cannot** reach
  this — `readSessionCookie` finds nothing and the route redirects to `/login`.
- Anyone who **explicitly logs in** with `demo@tesla-fleet-dashboard.dev` / `demo1234` (the
  credentials README publishes) gets a real, valid session cookie — the same mechanism as any
  real account. Navigating directly to `/auth/tesla/login` by URL, instead of clicking the
  hidden button, passes the route's only check and enters the real Tesla OAuth flow as the
  demo user.

**What happens if triggered:** the visitor completes a genuine Tesla OAuth consent flow with
their own real Tesla account. On success, `/auth/tesla/callback` writes real `vehicles` and
`vehicle_tokens` rows attributed to the **shared demo user id** (there is no per-visitor
identity — one demo account, one demo user row, for everyone).

**Blast radius:**

- The linked vehicle immediately becomes visible, via `User.vehicles`, to **every** subsequent
  visitor of the public demo — anonymous-fallback and explicit-login sessions alike, since
  both resolve to the same shared user.
- Once a `vehicle_tokens` row exists, the worker's poller (`INNER JOIN vehicle_tokens`, no
  `isDemo` awareness) starts polling that real vehicle on the normal live schedule,
  indefinitely — consuming the linking visitor's own Tesla account quota and counting against
  this app's `TESLA_MAX_CALLS_PER_DAY` cap.
- **No recovery path.** There is no unlink mutation anywhere in the schema. Reversing this
  requires manual deletion of the `vehicle_tokens` and `vehicles` rows directly in Postgres.
- This exposes the linking visitor's **own** real vehicle data (location, battery, charge
  state) outward to the public demo — not a demo-data leak inward.

**Not fixed as of this writing.** The two structurally sound places to close this, if you're
picking this up: an `isDemo` check inside `/auth/tesla/login` itself (mirroring the one
already proven out in `refreshVehicle`), and/or excluding the demo user id from ever reaching
that route. Either needs its own cookie → user → email lookup in `teslaAuth.js`, since that
route doesn't go through `buildContext` and has no `ctx.isDemo` in scope today.

**If you deploy this publicly with `DEMO_MODE_ENABLED=true`, treat this as open until fixed.**
