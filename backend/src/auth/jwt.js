import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

export function signToken(userId, expiresIn = "30d") {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn });
}

// Returns the userId, or null if missing/invalid/expired.
export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET).sub;
  } catch {
    return null;
  }
}
