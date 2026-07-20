const COOKIE_NAME = "session";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d, matches signToken's default expiry

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

export function readSessionCookie(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}
