# Tesla Fleet API Setup Guide

## 1. Prerequisites
- Tesla account (owner of the vehicle).
- Domain/subdomain with HTTPS already reachable (see Nginx setup in docker-compose.yml).
- Node.js locally for key generation.

## 2. Generate the Key Pair
```bash
openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem
```
- `private-key.pem` → `backend/keys/` (gitignored, never commit).
- `public-key.pem` → served at:
  `https://YOUR_SUBDOMAIN.yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem`

Verify before registering:
```bash
curl https://YOUR_SUBDOMAIN.yourdomain.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

## 3. Register the App (developer.tesla.com)
- App name: `tesla-fleet-dashboard`
- Redirect URI: `https://YOUR_SUBDOMAIN.yourdomain.com/auth/tesla/callback`
- Scopes: `openid`, `offline_access`, `vehicle_device_data`, `vehicle_location` (add `vehicle_cmds`, `vehicle_charging_cmds` only if commands are needed later)
- Region: Europe
- Submit → receive Client ID + Client Secret → store in `.env`

## 4. Partner Token (one-time domain registration)
```bash
curl --request POST \
  --url https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/partner_accounts \
  --header "Authorization: Bearer $PARTNER_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"domain": "YOUR_SUBDOMAIN.yourdomain.com"}'
```

## 5. User OAuth Flow
Authorize URL:
```
https://auth.tesla.com/oauth2/v3/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://YOUR_SUBDOMAIN.yourdomain.com/auth/tesla/callback&
  response_type=code&
  scope=openid offline_access vehicle_device_data vehicle_location&
  state=random_csrf_string
```

Exchange code for tokens:
```bash
curl --request POST \
  --url https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token \
  --data grant_type=authorization_code \
  --data client_id=$TESLA_CLIENT_ID \
  --data client_secret=$TESLA_CLIENT_SECRET \
  --data code=AUTH_CODE_FROM_REDIRECT \
  --data redirect_uri=https://YOUR_SUBDOMAIN.yourdomain.com/auth/tesla/callback
```
Store tokens in `vehicle_tokens` once the vehicle is linked (step 7).

## 6. Add Public Key to Vehicle (Virtual Key)
Using the Tesla app on your phone, logged into the same account, near/paired with the car:
visit the public key URL to trigger the "Add virtual key" prompt, confirm on the vehicle touchscreen.
Required for command endpoints; some data fields on newer firmware also require it.

## 7. Fetch Vehicle List & Link to DB
```bash
curl --request GET \
  --url https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles \
  --header "Authorization: Bearer $ACCESS_TOKEN"
```
Insert `id` (as `tesla_vehicle_id`) and `vin` via the `addVehicle` GraphQL mutation, then insert the token pair into `vehicle_tokens`.

## 8. Verify End-to-End
```bash
curl --request GET \
  --url https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/$VEHICLE_ID/vehicle_data \
  --header "Authorization: Bearer $ACCESS_TOKEN"
```

## Notes
- EU region base URL used throughout: `fleet-api.prd.eu.vn.cloud.tesla.com`.
- Refresh tokens rotate on each use — the shared `tesla-client` package persists the new one on every refresh.
- Monitor usage/cost at the developer.tesla.com dashboard post-launch.
- Free tier: $14/month credit per account. Estimated usage for this project's smart-polling design: ~4,050 Data requests/month — within free tier for typical single-vehicle personal use. Not a guarantee; monitor actual usage.
