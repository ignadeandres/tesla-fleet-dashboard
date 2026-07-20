import { Router } from "express";
import { exchangeAuthCode, fetchTeslaVehicles } from "tesla-client";
import { db } from "../db/pool.js";
import { verifyToken, signToken } from "../auth/jwt.js";
import { readSessionCookie } from "../auth/cookie.js";
import { getVehicleByTeslaVehicleId, insertVehicle } from "../db/queries/vehicles.js";
import { insertVehicleTokens } from "../db/queries/tokens.js";

const AUTHORIZE_URL = "https://auth.tesla.com/oauth2/v3/authorize";
const SCOPES = "openid offline_access vehicle_device_data vehicle_location";

const teslaConfig = {
  authBase: process.env.TESLA_AUTH_BASE || "https://fleet-auth.prd.vn.cloud.tesla.com",
  apiBase: process.env.TESLA_API_BASE,
  clientId: process.env.TESLA_CLIENT_ID,
  clientSecret: process.env.TESLA_CLIENT_SECRET,
  redirectUri: process.env.TESLA_REDIRECT_URI,
};

export const teslaAuthRouter = Router();

// state is a short-lived signed token carrying the dashboard user id, so the callback
// can attribute the linked vehicle(s) without needing a server-side session store.
teslaAuthRouter.get("/tesla/login", (req, res) => {
  const userId = verifyToken(readSessionCookie(req));
  if (!userId) return res.redirect("/login?error=auth_required");

  const state = signToken(userId, "10m");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", teslaConfig.clientId);
  url.searchParams.set("redirect_uri", teslaConfig.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

teslaAuthRouter.get("/tesla/callback", async (req, res) => {
  const { code, state } = req.query;
  const userId = state && verifyToken(state);
  if (!code || !userId) return res.redirect("/vehicles?linkError=invalid_request");

  try {
    const tokens = await exchangeAuthCode(code, teslaConfig);
    const teslaVehicles = await fetchTeslaVehicles(tokens.accessToken, teslaConfig);

    for (const tv of teslaVehicles) {
      let vehicle = await getVehicleByTeslaVehicleId(db, tv.id);
      if (!vehicle) {
        vehicle = await insertVehicle(db, {
          userId,
          teslaVehicleId: tv.id,
          vin: tv.vin,
          displayName: tv.display_name,
          model: null,
        });
      }
      await insertVehicleTokens(db, vehicle.id, tokens);
    }
    res.redirect("/vehicles?linked=1");
  } catch (err) {
    console.error("[tesla-oauth] callback failed:", err.message);
    res.redirect("/vehicles?linkError=exchange_failed");
  }
});
