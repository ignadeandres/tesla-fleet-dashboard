import { GraphQLError } from "graphql";
import {
  createTeslaClient,
  handleTripPoint,
  closeTripIfOpen,
  handleChargingUpdate,
  closeChargingSessionIfOpen,
} from "tesla-client";
import { db } from "../../db/pool.js";
import { getUserByEmail, createUser } from "../../db/queries/users.js";
import { insertSnapshot, getLatestSnapshot } from "../../db/queries/telemetry.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { signToken } from "../../auth/jwt.js";
import { setSessionCookie, clearSessionCookie } from "../../auth/cookie.js";
import { requireOwnedVehicle } from "./helpers.js";
import { DEMO_EMAIL } from "../../demo/context.js";

const teslaConfig = {
  apiBase: process.env.TESLA_API_BASE,
  authBase: process.env.TESLA_AUTH_BASE || "https://fleet-auth.prd.vn.cloud.tesla.com",
  clientId: process.env.TESLA_CLIENT_ID,
};
const tesla = createTeslaClient(db, teslaConfig);

const RATE_LIMIT_MS = 60 * 1000;
const lastRefreshAt = new Map();

async function login(_, { email, password }, ctx) {
  const user = await getUserByEmail(ctx.db, email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new GraphQLError("Invalid email or password", { extensions: { code: "UNAUTHENTICATED" } });
  }
  const token = signToken(user.id);
  setSessionCookie(ctx.res, token);
  return { token, user: { id: user.id, email: user.email } };
}

async function register(_, { email, password }, ctx) {
  if (email === DEMO_EMAIL) {
    throw new GraphQLError("Email already registered", { extensions: { code: "BAD_USER_INPUT" } });
  }
  if (await getUserByEmail(ctx.db, email)) {
    throw new GraphQLError("Email already registered", { extensions: { code: "BAD_USER_INPUT" } });
  }
  const user = await createUser(ctx.db, email, await hashPassword(password));
  const token = signToken(user.id);
  setSessionCookie(ctx.res, token);
  return { token, user };
}

function logout(_, __, ctx) {
  clearSessionCookie(ctx.res);
  return true;
}

async function refreshVehicle(_, { id }, ctx) {
  if (ctx.isDemo) {
    throw new GraphQLError("Not available in demo mode", { extensions: { code: "FORBIDDEN" } });
  }
  const vehicle = await requireOwnedVehicle(ctx, id);

  const last = lastRefreshAt.get(vehicle.id) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) {
    throw new GraphQLError("Refresh rate-limited, try again shortly", { extensions: { code: "RATE_LIMITED" } });
  }
  lastRefreshAt.set(vehicle.id, Date.now());

  let lite = await tesla.getVehicleLite(vehicle.id, vehicle.teslaVehicleId);
  // Gate on "online", not on "asleep": Tesla also reports "offline" and "waking", and
  // vehicle_data answers 408 for all of them — so anything short of online needs the
  // wake-and-poll loop, not a straight-to-full-poll that fails.
  if (lite.response?.state !== "online") {
    await tesla.wakeVehicle(vehicle.id, vehicle.teslaVehicleId);
    for (let attempt = 0; attempt < 5 && lite.response?.state !== "online"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      lite = await tesla.getVehicleLite(vehicle.id, vehicle.teslaVehicleId);
    }
    if (lite.response?.state !== "online") {
      // Name the state — "offline" (no connectivity) and "asleep" (won't wake) are very
      // different problems and the old message couldn't tell them apart.
      throw new GraphQLError(`Vehicle is ${lite.response?.state || "unreachable"} and did not wake up in time`, {
        extensions: { code: "VEHICLE_UNREACHABLE" },
      });
    }
  }

  const full = await tesla.getVehicleState(vehicle.id, vehicle.teslaVehicleId);
  const data = full.response;

  if (!data.vehicle_state) {
    // Confirmed by production testing: even a 30s wake-and-retry loop never got
    // vehicle_state back here. Tesla's wake_up is for a genuinely "asleep" vehicle —
    // this one already shows "online" (charging, BMS responsive), and Tesla simply
    // doesn't populate vehicle_state/drive_state/climate_state for a parked,
    // charging car regardless of wake pings (almost certainly deliberate, to stop
    // apps abusing wake_up to drain the 12V battery overnight). Retrying bought
    // nothing but 30s of wasted wait — not attempting it again. odometer/locked/GPS
    // stay whatever getLatestSnapshot's fallback carries forward; it'll catch up for
    // real next time the vehicle is actually driven.
    console.warn(`[refreshVehicle] vehicle ${vehicle.id} online but vehicle_state missing (MCU asleep mid-charge)`);
  }

  const driving = ["D", "R", "N"].includes(data.drive_state?.shift_state) || data.drive_state?.speed > 0;
  const charging = data.charge_state?.charging_state === "Charging";
  const state = driving ? "driving" : charging ? "charging" : "online";

  await insertSnapshot(ctx.db, vehicle.id, { state, ts: new Date(), raw: data });

  if (driving) {
    await handleTripPoint(ctx.db, vehicle.id, data);
  } else {
    await closeTripIfOpen(ctx.db, vehicle.id, data);
  }
  if (charging) {
    await handleChargingUpdate(ctx.db, vehicle.id, data);
  } else {
    await closeChargingSessionIfOpen(ctx.db, vehicle.id, data);
  }

  return getLatestSnapshot(ctx.db, vehicle.id);
}

export const Mutation = { login, register, logout, refreshVehicle };
