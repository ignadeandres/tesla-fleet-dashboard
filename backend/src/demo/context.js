import { db } from "../db/pool.js";
import { verifyToken } from "../auth/jwt.js";
import { readSessionCookie } from "../auth/cookie.js";

// ponytail: must match DEMO_EMAIL in scripts/seed-demo-data.js — not worth a shared
// config module for one string shared between two small scripts/services.
export const DEMO_EMAIL = "demo@tesla-fleet-dashboard.dev";
const DEMO_MODE_ENABLED = process.env.DEMO_MODE_ENABLED === "true";

let demoUserId = null;
async function getDemoUserId() {
  if (demoUserId) return demoUserId;
  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
  demoUserId = rows[0]?.id || null;
  return demoUserId;
}

export async function buildContext(req, res) {
  const token = readSessionCookie(req);
  const userId = token ? verifyToken(token) : null;

  if (userId) {
    const { rows } = await db.query(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    // isDemo is keyed off the account's email, not how the session was resolved — the
    // demo account is read-only whether reached anonymously or via its published
    // login/password (README advertises both).
    if (rows[0]) return { db, user: rows[0], isDemo: rows[0].email === DEMO_EMAIL, res };
  }

  if (DEMO_MODE_ENABLED) {
    const id = await getDemoUserId();
    if (id) return { db, user: { id, email: DEMO_EMAIL }, isDemo: true, res };
  }

  return { db, user: null, isDemo: false, res };
}
