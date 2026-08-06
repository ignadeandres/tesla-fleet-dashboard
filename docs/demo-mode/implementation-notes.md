# Implementation Notes — Demo Mode

**Feature:** Public, read-only, seeded demo account
**Status:** Implemented and shipped. See `docs/demo-mode/tech-spec.md` for the full architecture/data/API design — this doc covers what's actually in the code, files touched, and gotchas found while reading it.

## Summary

Demo mode is not a parallel code path — it's a second, lower-priority branch inside the same `buildContext(req, res)` function every GraphQL request already goes through (`backend/src/demo/context.js`). A valid session cookie always wins; the seeded demo user (`demo@tesla-fleet-dashboard.dev`) is only used as a fallback when there's no session and `DEMO_MODE_ENABLED === "true"`. `isDemo` is never stored — it's `user.email === DEMO_EMAIL`, recomputed on every request and independently on every `User.isDemo` field resolution, so there's exactly one source of truth. The only enforcement point in the whole app is `refreshVehicle`; every other mutation/route is unaware of `isDemo`, which is the root of the confirmed security gap in `docs/demo-mode/tech-spec.md`'s Security Notes (`/auth/tesla/login` — see below, not re-derived here).

## Key files and their role

- **`backend/src/demo/context.js`** — `buildContext`. Resolution order: (1) session cookie → real user, `isDemo` from that user's email; (2) no/invalid cookie + `DEMO_MODE_ENABLED` → seeded demo user by email, `isDemo: true`; (3) neither → `user: null, isDemo: false`. `DEMO_EMAIL` is exported from here and re-imported by `types.js`. The demo user's id is resolved by email once per process and cached in the module-level `demoUserId` — explicitly marked `ponytail:` in the file, relies on the seed script never changing the row's id on re-run and on `DEMO_MODE_ENABLED` being a compose-time env var (needs a restart to change anyway).
- **`scripts/seed-demo-data.js`** — self-executing `seed()`, run via `npm run seed:demo` (confirmed in `package.json`). One transaction: 1 `users` row + 1 `vehicles` row (both `ON CONFLICT ... DO NOTHING`, idempotent), then 673 `telemetry_snapshots` (7 days × 15-min cadence, synthetic charge curve), 5 `trips` × 16 `trip_points` each, 3 `charging_sessions` — none of the time-series inserts have a conflict guard, so re-running the script after the first successful seed duplicates history. Never inserts a `vehicle_tokens` row for the demo vehicle, which is also why the worker's poller (join on `vehicle_tokens`) never touches it under normal operation.
- **`backend/src/graphql/resolvers/mutation.js`** (`refreshVehicle`) — the one and only mutation that checks `ctx.isDemo`. Check is first in the function body, before `requireOwnedVehicle`, so a demo caller gets `FORBIDDEN ("Not available in demo mode")` even for a vehicle they don't own, never a `NOT_FOUND`. `login`/`register`/`logout` are untouched by demo logic.
- **`backend/src/graphql/resolvers/types.js`** (`User.isDemo`) — `(user) => user.email === DEMO_EMAIL`, imported straight from `context.js`. Deliberately derived from the resolved `user` object per-call rather than read off `ctx.isDemo`, since `ctx` is built once before any mutation runs in the same request and can't reflect a user `login`/`register` just resolved.
- **`backend/src/routes/teslaAuth.js`** (`GET /tesla/login`) — plain Express route, outside GraphQL entirely, so it never calls `buildContext` and has no `isDemo` awareness of any kind. Its only check is `verifyToken(readSessionCookie(req))` resolving to *some* user id. This is the confirmed gap documented in full in `docs/demo-mode/tech-spec.md`'s Security Notes (who can trigger it, blast radius, no recovery path) — not restated here, cross-reference only. `docker-compose.yml:38` hardcodes `DEMO_MODE_ENABLED: "true"` (not `${VAR}`-interpolated like its siblings in that file).

## Notable gotchas for future maintainers

- **`DEMO_EMAIL` is a literal string duplicated** in `backend/src/demo/context.js` and `scripts/seed-demo-data.js` — same duplication already flagged in `docs/authentication/implementation-notes.md`, still true, still marked with a `ponytail:` comment as intentional (not worth a shared config module for one string).
- **`refreshVehicle` is the only demo-aware mutation.** Any new mutation that mutates state on a vehicle/account needs its own `ctx.isDemo` check added explicitly — there's no shared guard/middleware that does this automatically, so it's easy to ship a new mutation that silently lets the demo account write.
- **`/auth/tesla/login` has no `isDemo` check** — confirmed by direct read of `teslaAuth.js`, matches the tech spec exactly. It's a plain Express route that never touches `buildContext`, so there's no `ctx.isDemo` in scope to check even if someone wanted to add it inline; the fix (per the tech spec) needs its own cookie→user→email lookup or a shared helper. Full attack path and blast radius: `docs/demo-mode/tech-spec.md` → Security Notes.
- **`demoUserId` module-level cache** means a demo-mode toggle or a manual demo-user id change in the DB requires a backend process restart to take effect — no cache invalidation path exists.

## Verification / test coverage

Ran the backend suite read-only, no changes made:

- `backend`: `npm test` → `node --test $(find src -name '*.test.js')`, **13/13 passing**. Same result as recorded in `docs/authentication/implementation-notes.md`.
- `backend/src/graphql/resolvers/types.test.js` exists but only covers `efficiencyKmPerPercent` — **no test exercises the `isDemo` resolver**.
- No test file exists for `backend/src/demo/context.js` at all (`find` over `src/**/*.test.js` confirms this — the only test files in `backend/src` are `auth/jwt.test.js`, `graphql/resolvers/helpers.test.js`, `graphql/resolvers/types.test.js`, `db/queries/telemetry.test.js`). This matches and reconfirms the gap already called out in `docs/authentication/implementation-notes.md` ("`backend/src/demo/context.js` — `buildContext`'s cookie→user resolution and demo-mode fallback path untested") — still accurate as of this read, nothing changed since that doc was written.

**Gaps — not covered by any test in the repo:**
- `backend/src/demo/context.js` — neither resolution branch (real-session vs. demo-fallback vs. neither) has a test, nor does the `demoUserId` caching behavior.
- `backend/src/graphql/resolvers/mutation.js` — `refreshVehicle`'s `ctx.isDemo` early-return (`FORBIDDEN`, runs before ownership check) has no test.
- `backend/src/graphql/resolvers/types.js` — `User.isDemo` resolver has no test (file only tests `efficiencyKmPerPercent`).
- `backend/src/routes/teslaAuth.js` — no test file for `/tesla/login` or `/tesla/callback` at all (also already noted in the authentication doc); this is also where the unfixed `isDemo` gap lives, so the missing coverage and the missing fix are the same file.
- `scripts/seed-demo-data.js` — no test; it's a one-shot operational script, not imported by app code, consistent with how it's treated elsewhere (not flagged as a meaningful gap, just noted for completeness).

This is a documentation-only pass — no code, test, or config files were created or modified.
