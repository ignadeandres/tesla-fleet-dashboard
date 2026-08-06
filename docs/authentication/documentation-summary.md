# Documentation Summary — Authentication

**What was documented:** the GraphQL auth API (login/register/logout/me — request/response shape, error codes), the Tesla OAuth linking flow (both REST endpoints, what the `state` param carries, redirect outcomes), and session cookie mechanics (name, flags, expiry). Written as a developer-facing reference, with every claim re-verified against current source rather than copied from the spec docs.

**Where:**
- `docs/authentication.md` (new) — the real reference doc.
- `README.md` — added one line under `## Documentation` linking to it; no other changes.

**Verification:** re-read `backend/src/auth/{jwt,cookie,password}.js`, `backend/src/routes/teslaAuth.js`, `backend/src/graphql/resolvers/{mutation,query,helpers,types}.js`, `backend/src/graphql/schema.graphql`, `backend/src/demo/context.js`, `backend/src/index.js`, `frontend/src/auth/{AuthContext,LoginPage}.jsx`, `frontend/src/graphql/queries/auth.js`, `frontend/src/pages/VehiclesPage.jsx` directly — no discrepancy found between the pipeline docs and the code.

**Notable finding surfaced in the new doc:** `AuthPayload.token` is returned by `login`/`register` but the frontend never selects or reads it (`frontend/src/graphql/queries/auth.js` only selects `user { id }`) — session auth is cookie-only in practice, so `token` is effectively dead in the current frontend. Flagged as a gotcha for anyone building a non-cookie (e.g. bearer-token) client against this API.

## Pipeline trail for this feature
- `docs/authentication/business-requirements.md`
- `docs/authentication/functional-spec.md`
- `docs/authentication/tech-spec.md`
- `docs/authentication/implementation-notes.md`
- `docs/authentication/documentation-summary.md` (this file)
