# Documentation Summary — Vehicle Telemetry Polling

**What was documented:** the adaptive polling cadence table (and how it's derived from last-known vehicle state), the lite-check-before-full-poll flow, the daily API call budget mechanism and its two tuning env vars, and known limitations (in-memory trip/charging/lastPollAt state lost on worker restart, shared global budget not per-vehicle). Verified against real code, not copied from spec docs.

**Where:**
- `docs/vehicle-telemetry-polling.md` (new) — operator/developer reference doc.
- `README.md` — one line added under `## Documentation`, same pattern as the `authentication.md` link; no other changes.

**Verification:** re-read `worker/src/poller.js`, `worker/src/stateMachine.js`, `worker/src/apiBudget.js`, `worker/src/handlers/{snapshot,trip,charging}.js`, `packages/tesla-client/src/{client,snapshot,units}.js`. Confirmed env var names/defaults exactly: `TESLA_MAX_CALLS_PER_DAY` (default 300), `BATTERY_CAPACITY_KWH` (default 75). No discrepancy found between the pipeline docs and the code.

## Pipeline trail for this feature
- `docs/vehicle-telemetry-polling/business-requirements.md`
- `docs/vehicle-telemetry-polling/functional-spec.md`
- `docs/vehicle-telemetry-polling/tech-spec.md`
- `docs/vehicle-telemetry-polling/implementation-notes.md`
- `docs/vehicle-telemetry-polling/documentation-summary.md` (this file)
