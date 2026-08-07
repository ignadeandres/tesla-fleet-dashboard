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
  if (lite.response?.state === "asleep") {
    await tesla.wakeVehicle(vehicle.id, vehicle.teslaVehicleId);
    for (let attempt = 0; attempt < 5 && lite.response?.state === "asleep"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      lite = await tesla.getVehicleLite(vehicle.id, vehicle.teslaVehicleId);
    }
    if (lite.response?.state === "asleep") {
      throw new GraphQLError("Vehicle did not wake up in time", { extensions: { code: "VEHICLE_UNREACHABLE" } });
    }
  }

  let full = await tesla.getVehicleState(vehicle.id, vehicle.teslaVehicleId);
  let data = full.response;

  if (!data.vehicle_state) {
    // The car can show "online" and keep charging (BMS responsive) while its main
    // computer is fully asleep — Tesla then omits vehicle_state/drive_state/
    // climate_state from vehicle_data entirely (not just individual fields), which
    // is why odometer/locked/GPS can go missing even though charge_state is fine.
    // An explicit wake gets the rest of the telemetry back; a plain re-poll won't.
    // 10x3s (double the asleep-wake budget above): waking the MCU specifically
    // while mid-charge seems to take longer than a plain sleep->online wake.
    await tesla.wakeVehicle(vehicle.id, vehicle.teslaVehicleId);
    for (let attempt = 0; attempt < 10 && !data.vehicle_state; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      full = await tesla.getVehicleState(vehicle.id, vehicle.teslaVehicleId);
      data = full.response;
    }
    if (!data.vehicle_state) {
      // Not fatal — still save whatever charge_state gave us (fresh battery/range),
      // getLatestSnapshot's fallback covers the rest. Logged so we can tell, from
      // actual usage, whether this is a timing issue (needs more budget) or Tesla's
      // wake_up just doesn't force vehicle_state while the vehicle is already
      // "online" (charging) rather than genuinely "asleep".
      console.warn(`[refreshVehicle] vehicle ${vehicle.id} woke but vehicle_state still missing after retries`);
    }
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
