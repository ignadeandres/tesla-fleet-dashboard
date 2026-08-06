# Tesla Fleet Dashboard — Project Overview & Documentation Index

This file used to be a single monolithic functional spec for the whole project. It's now a short project-level overview — detailed, per-feature documentation (business requirements, functional spec, tech spec, implementation notes) lives under `docs/<feature-slug>/`, one folder per feature, and real developer/operator reference docs live at the top level of `docs/`.

## Overview

Private/public web platform to monitor Tesla vehicle(s) via the official **Tesla Fleet API**. Multi-user capable (JWT auth), each user owns 1-N vehicles. Includes a public, seeded **Demo Mode** for portfolio/CV viewing, separate from real authenticated user data.

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + MUI |
| API | GraphQL |
| Backend | Node.js |
| DB | PostgreSQL |
| Worker | Node.js (decoupled process) |
| Maps | OpenStreetMap (Leaflet) |
| Auth | JWT (httpOnly cookie) |
| Deployment | Docker Compose on VPS |
| Repo | npm workspaces monorepo (`/frontend`, `/backend`, `/worker`, `/packages/tesla-client`, `/docs`) |
| License | MIT |
| Tesla API Region | EU (`fleet-api.prd.eu.vn.cloud.tesla.com`) |

## Architecture

```
┌─────────────┐     GraphQL      ┌─────────────┐
│  React/MUI   │ ───────────────▶ │   Backend    │
│  Frontend    │ ◀─────────────── │  (API layer) │
└─────────────┘                  └──────┬──────┘
                                         │
                                  ┌──────▼──────┐
                                  │  PostgreSQL  │
                                  └──────▲──────┘
                                         │
                                  ┌──────┴──────┐
                                  │   Worker     │──▶ Tesla Fleet API
                                  │ (poller/cron)│    (OAuth2 + refresh)
                                  └─────────────┘
```

- **Worker**: independent process, adaptive polling (see `docs/vehicle-telemetry-polling.md`), writes directly to Postgres.
- **Backend**: GraphQL API, reads/writes Postgres, serves frontend, handles auth (see `docs/authentication.md`).
- **Frontend**: React SPA, MUI components, consumes GraphQL.
- **`packages/tesla-client`**: shared workspace package — Tesla OAuth, token refresh, and Fleet API calls, used by both `backend` and `worker` so this logic exists exactly once.

## Data Model (core entities)

Full schema, constraints, and rationale for each table live in the feature docs that own them:

- **`users`**, **`vehicles`**, **`vehicle_tokens`** — see `docs/authentication/tech-spec.md`
- **`telemetry_snapshots`**, **`trips`**, **`trip_points`**, **`charging_sessions`**, **`api_call_budget`** — see `docs/vehicle-telemetry-polling/tech-spec.md`

## Feature Documentation Index

Each feature below has a full SDLC paper trail at `docs/<feature-slug>/` (business-requirements → functional-spec → tech-spec → implementation-notes → documentation-summary), retroactively documented against the shipped code. Where a feature has genuine operational/developer-reference value beyond its pipeline trail, a real reference doc also exists at the top level of `docs/` (linked below and from `README.md`).

| Feature | Pipeline trail | Reference doc |
|---|---|---|
| Authentication (JWT session + Tesla OAuth linking) | `docs/authentication/` | [docs/authentication.md](authentication.md) |
| Vehicle telemetry polling (worker adaptive polling + API budget) | `docs/vehicle-telemetry-polling/` | [docs/vehicle-telemetry-polling.md](vehicle-telemetry-polling.md) |
| Trips (trip history list + map) | `docs/trips/` | — (thin read-side view; non-obvious behavior is covered by inline code comments) |
| Charging sessions (charging history table) | `docs/charging-sessions/` | — (same as above) |
| Battery health trends (battery % chart — note: not a degradation metric, see the feature's business-requirements for the naming caveat) | `docs/battery-health-trends/` | — (same as above) |
| Vehicle state log (state history table) | `docs/vehicle-state-log/` | — (same as above) |
| Demo mode (public seeded read-only account) | `docs/demo-mode/` | [docs/demo-mode.md](demo-mode.md) — **includes a known security issue**, read before deploying publicly |
| Dashboard overview (per-vehicle landing page + vehicle selector) | `docs/dashboard-overview/` | [docs/dashboard-overview.md](dashboard-overview.md) |

## Out of Scope (v1, still accurate)

- Notifications/alerts (push, email, in-app).
- Charging cost estimation.
- CI/CD pipelines.
- Multi-timezone support (single fixed timezone; UTC stored, converted in UI).

## Setup

Tesla Developer app registration, key pairing, and deployment steps: see [docs/setup-tesla-api.md](setup-tesla-api.md) and the Quick Start in the repo [README](../README.md).

## Non-Functional Requirements

- Data retention: permanent (no purge).
- Timezone: UTC stored, single fixed display timezone in UI.
- Security: secrets never committed; demo data seed script provided for public/local use (see `docs/demo-mode.md` for its known security caveat).
- Portfolio quality: clean commit history, README with architecture diagram, MIT license.
