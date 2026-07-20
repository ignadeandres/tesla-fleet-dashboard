# Functional Specification — Tesla Fleet Dashboard

## 1. Overview
Private/public web platform to monitor Tesla vehicle(s) via the **Tesla Fleet API**. Multi-user capable (JWT auth), each user owns 1-N vehicles. Public GitHub repo (portfolio piece) with a **Demo Mode** for recruiters and a **Real Mode** for authenticated owner data.

## 2. Objectives
- Continuous, battery-conscious telemetry collection.
- Historical, permanent storage of all available vehicle data.
- Public-facing, CV-quality codebase with clean architecture and demo capability.

## 3. Tech Stack
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
| Repo | Monorepo (`/frontend`, `/backend`, `/worker`, `/docs`) |
| License | MIT |
| Tesla API Region | EU (`fleet-api.prd.eu.vn.cloud.tesla.com`) |

## 4. Architecture

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

- **Worker**: independent process, smart polling, writes directly to Postgres.
- **Backend**: GraphQL API, reads from Postgres, serves frontend, handles auth.
- **Frontend**: React SPA, MUI components, consumes GraphQL.

## 5. Data Model (core entities)

- **users**: id, email, password_hash, created_at
- **vehicles**: id, user_id (FK), vin, display_name, model, tesla_vehicle_id
- **vehicle_tokens**: vehicle_id (FK), access_token, refresh_token, expires_at
- **telemetry_snapshots**: vehicle_id, timestamp, battery_level, speed, lat, lng, odometer, state (asleep/online/driving), software_version, climate_state, lock_state, door/window states, etc. (all Fleet API fields captured as available)
- **trips**: id, vehicle_id, start_time, end_time, start_lat/lng, end_lat/lng, distance, route_points (array/table of breadcrumb GPS points)
- **charging_sessions**: id, vehicle_id, start_time, end_time, start_battery_level, end_battery_level, energy_added_kwh, location (lat/lng), (cost estimation deferred to v2)

## 6. Feature Scope (v1)

### 6.1 Authentication
- JWT-based login, single account can own multiple vehicles.
- Demo Mode toggle: public deployment shows read-only seeded demo data without login; logging in reveals real user's own vehicle data only.

### 6.2 Data Collection (Worker)
- **Smart polling**: base interval 15 min; reduces frequency when vehicle is asleep (avoid wake calls), increases frequency when driving or charging.
- Automatic OAuth token refresh before each poll (checks expiry, refreshes silently, persists new token).
- Full GPS breadcrumb capture during trips (not just start/end).
- Captures all available Fleet API data fields (battery, climate, doors, locks, software, tire pressure, etc.) per snapshot.

### 6.3 Dashboards (Frontend)
1. **Overview** — current vehicle state, live location, battery %, quick stats.
2. **Trips** — map view (Leaflet/OSM) with full route playback, trip list, distance/duration history.
3. **Charging Sessions** — history list, start/end battery %, kWh added, location, duration (no cost in v1).
4. **Battery & Health Trends** — charts over time (degradation proxy, battery % patterns).
5. **Vehicle State Log** — timeline of lock/climate/door/window state changes.

### 6.4 Multi-Vehicle Support
- User can register multiple vehicles; all dashboards are vehicle-scoped via a vehicle selector.
- Strict data isolation: users only query their own vehicles (enforced at GraphQL resolver level via `user_id`).

## 7. Out of Scope (v1)
- Notifications/alerts (push, email, in-app).
- Charging cost estimation.
- CI/CD pipelines.
- Multi-timezone support (single fixed timezone; UTC stored, converted in UI).

## 8. Setup Requirements (to be documented in README)
- Tesla Developer account + registered Fleet API app (EU region).
- Public key hosted at `/.well-known/appspecific/com.tesla.3p.public-key.pem` on deployment domain.
- Virtual key pairing via Tesla mobile app (per vehicle).
- `.env` file for secrets (Tesla client ID/secret, JWT secret, DB credentials) — excluded via `.gitignore`.
- Docker Compose stack: `frontend`, `backend`, `worker`, `postgres`.

## 9. Non-Functional Requirements
- Data retention: permanent (no purge).
- Timezone: UTC stored, single fixed display timezone in UI.
- Security: secrets never committed; demo data seed script provided for public/local use.
- Portfolio quality: clean commit history, README with architecture diagram, MIT license.

## 10. Open Items for Next Iteration
- Repo name confirmation (proposed: `tesla-fleet-dashboard`).
- GraphQL schema draft.
- Postgres schema/migration draft.
- Worker polling state-machine detail (asleep/driving/charging thresholds).
