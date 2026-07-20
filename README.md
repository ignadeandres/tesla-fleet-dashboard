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
Point your domain's DNS at the VPS first (an A/AAAA record, not proxied through a CDN —
Tesla's domain validation rejects proxied domains).

```bash
cp .env.example .env   # fill in DB/JWT values; leave TESLA_CLIENT_ID/SECRET blank for now
sed -i 's/YOUR_SUBDOMAIN.yourdomain.com/your.actual.domain/g' nginx/conf.d/app.conf

# nginx/conf.d/app.conf references a cert that doesn't exist yet — comment out the
# `server { listen 443 ssl; ... }` block for this first boot, then:
docker compose up -d --build

docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot \
  -d your.actual.domain --email you@example.com --agree-tos --no-eff-email

# restore the 443 server block you commented out above, then:
docker compose restart nginx

npm run seed:demo      # optional: populate demo user/vehicle data (run from the host,
                        # against the dockerized Postgres exposed on 127.0.0.1:5432)
```

Note the `--entrypoint certbot` override above: the `certbot` service's default entrypoint
runs a renewal loop (`certbot renew`, for certs that already exist) so it can be started
with `docker compose up -d`; getting the *first* certificate needs `certonly` instead,
which requires overriding that entrypoint back to plain `certbot`.

Then follow [docs/setup-tesla-api.md](docs/setup-tesla-api.md) to register your Tesla Developer app,
generate the vehicle command key pair, and link your vehicle.

## Demo
Live demo mode: log in with `demo@tesla-fleet-dashboard.dev` / `demo1234` (seeded, read-only, no real vehicle).

## License
MIT
