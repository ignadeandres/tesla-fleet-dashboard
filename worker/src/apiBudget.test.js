import test from "node:test";
import assert from "node:assert/strict";
import { checkAndConsumeBudget } from "./apiBudget.js";

function makeFakeDb(startingCalls) {
  let calls = startingCalls;
  return {
    query: async (sql) => {
      if (sql.includes("SELECT calls")) return { rows: [{ calls }] };
      if (sql.includes("INSERT INTO api_call_budget")) {
        calls += 1;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    get calls() {
      return calls;
    },
  };
}

// Uses the module's default cap (300/day — see apiBudget.js) since MAX_CALLS_PER_DAY
// is read from process.env once at import time, before a test could override it.
test("allows and counts a call when under the daily cap", async () => {
  const db = makeFakeDb(5);
  const allowed = await checkAndConsumeBudget(db);
  assert.equal(allowed, true);
  assert.equal(db.calls, 6);
});

test("blocks the call once the daily cap is reached, without counting it", async () => {
  const db = makeFakeDb(300);
  const allowed = await checkAndConsumeBudget(db);
  assert.equal(allowed, false);
  assert.equal(db.calls, 300, "a blocked call must not itself consume budget");
});
