# Documentation Summary — Demo Mode

**What was documented:** how demo mode works (the `buildContext` fallback resolution priority), how an operator enables/seeds it (`DEMO_MODE_ENABLED`, `npm run seed:demo`, the idempotency boundary), what's blocked for the demo account (`refreshVehicle`), and — the main reason this feature warranted a real doc, unlike the four thinner features before it — a prominent **"Known Security Issue"** section covering the confirmed gap: `GET /auth/tesla/login` has no `isDemo` check, so a visitor who explicitly logs in with the published demo credentials can link a real Tesla vehicle to the shared public demo account, with no unlink path and ongoing API quota exposure.

**Where:**
- `docs/demo-mode.md` (new) — top-level operator/developer reference, same style as `docs/authentication.md` and `docs/vehicle-telemetry-polling.md`.
- `README.md` — one line added under `## Documentation` linking to it.

**Verification:** re-read `backend/src/demo/context.js`, `backend/src/routes/teslaAuth.js`, `backend/src/graphql/resolvers/{mutation,types}.js`, `scripts/seed-demo-data.js`, `docker-compose.yml`, and confirmed the route mount in `backend/src/index.js`. The security section was rebuilt from a fresh code read, not copied from prior spec prose.

**Correction found and applied:** the technical-writer caught that `docs/demo-mode/tech-spec.md` mislabeled `/auth/tesla/login` as a `POST` route — it's actually `GET` (`teslaAuthRouter.get(...)`). Fixed in `docs/demo-mode/tech-spec.md` (both occurrences) so the pipeline trail stays accurate.

## Pipeline trail for this feature
- `docs/demo-mode/business-requirements.md`
- `docs/demo-mode/functional-spec.md`
- `docs/demo-mode/tech-spec.md`
- `docs/demo-mode/implementation-notes.md`
- `docs/demo-mode/documentation-summary.md` (this file)
