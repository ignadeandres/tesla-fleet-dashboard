// Hard ceiling on billed Tesla API calls, independent of the per-vehicle polling
// intervals in stateMachine.js. Those intervals keep normal usage low, but this is
// the backstop that caps worst-case exposure if a future bug (or a fleet of many
// vehicles) drives usage up anyway — persisted in the DB so a worker restart can't
// reset it. Tune TESLA_MAX_CALLS_PER_DAY against the actual free quota shown on
// the Fleet API Developer Dashboard's Billing and Usage page.
const MAX_CALLS_PER_DAY = Number(process.env.TESLA_MAX_CALLS_PER_DAY || 300);

export async function checkAndConsumeBudget(db) {
  const { rows } = await db.query(`SELECT calls FROM api_call_budget WHERE day = CURRENT_DATE`);
  if ((rows[0]?.calls || 0) >= MAX_CALLS_PER_DAY) return false;
  await db.query(
    `INSERT INTO api_call_budget (day, calls) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET calls = api_call_budget.calls + 1`
  );
  return true;
}
