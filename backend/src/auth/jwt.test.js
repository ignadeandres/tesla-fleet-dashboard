import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";
const { signToken, verifyToken } = await import("./jwt.js");

test("signToken/verifyToken roundtrip returns the original user id", () => {
  const token = signToken("user-123");
  assert.equal(verifyToken(token), "user-123");
});

test("verifyToken rejects a token signed with a different secret", () => {
  const forged = jwt.sign({ sub: "user-123" }, "wrong-secret");
  assert.equal(verifyToken(forged), null);
});

test("verifyToken rejects an expired token", () => {
  const expired = jwt.sign({ sub: "user-123" }, "test-secret", { expiresIn: -1 });
  assert.equal(verifyToken(expired), null);
});
