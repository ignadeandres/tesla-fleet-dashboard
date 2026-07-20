# Tesla Fleet Dashboard

Private monitoring dashboard for Tesla vehicles, built on the official Tesla Fleet API.
Multi-user capable (JWT auth), each user owns 1-N vehicles. Includes a public **Demo Mode**
with seeded data for portfolio/CV viewing, separate from real authenticated user data.

## Stack
Node.js · GraphQL · React · MUI · PostgreSQL · Docker Compose · Nginx (TLS via Let's Encrypt) · OpenStreetMap/Leaflet

## Features
- Smart, battery-conscious polling (backs off when vehicle asleep, speeds up when driving/charging)
- Manual "Refresh Now" button (wakes vehicle on demand, rate-limited)
- Full GPS breadcrumb trip history
- Charging session history (start/end battery %, energy added, location)
- Vehicle state timeline (locks, climate, doors, windows)
- Permanent data retention in PostgreSQL

## Documentation
- [Functional Specification](docs/functional-spec.md)
- [Tesla Fleet API Setup Guide](docs/setup-tesla-api.md)

## Quick Start
```bash
cp .env.example .env   # fill in your values
docker compose up -d --build
docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
  -d YOUR_SUBDOMAIN.yourdomain.com --email you@example.com --agree-tos --no-eff-email
docker compose restart nginx
npm run seed:demo      # optional: populate demo user/vehicle data
```

Then follow [docs/setup-tesla-api.md](docs/setup-tesla-api.md) to register your Tesla Developer app,
generate the vehicle command key pair, and link your vehicle.

## Demo
Live demo mode: log in with `demo@tesla-fleet-dashboard.dev` / `demo1234` (seeded, read-only, no real vehicle).

## License
MIT
