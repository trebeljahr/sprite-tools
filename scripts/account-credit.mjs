import { Pool } from "pg";
// Operator-only, idempotent grants. No browser/API endpoint may call this script.
const [owner, amountText, grantId] = process.argv.slice(2);
const amount = Number(amountText);
if (
  !owner ||
  !Number.isSafeInteger(amount) ||
  amount <= 0 ||
  !/^[0-9a-f-]{36}$/i.test(grantId ?? "") ||
  !(
    process.env.POSTGRES_URL ||
    (process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  )
) {
  throw new Error(
    "Usage: accounts:credit <user-id|__global__> <positive-integer-credits> <grant-uuid>; POSTGRES_URL required",
  );
}
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
const db = await pool.connect();
try {
  await db.query("BEGIN");
  if (
    owner !== "__global__" &&
    !(await db.query('SELECT id FROM "user" WHERE id=$1 AND "emailVerified"=true', [owner]))
      .rowCount
  )
    throw new Error("Unknown verified account");
  const grant = await db.query(
    "INSERT INTO video_credit_grants(id,owner_id,amount) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
    [grantId, owner, amount],
  );
  if (!grant.rowCount) {
    const existing = await db.query("SELECT owner_id,amount FROM video_credit_grants WHERE id=$1", [
      grantId,
    ]);
    if (existing.rows[0].owner_id !== owner || Number(existing.rows[0].amount) !== amount)
      throw new Error("Grant ID conflict");
  } else {
    await db.query(
      "INSERT INTO video_budgets(owner_id,available) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET available=video_budgets.available+EXCLUDED.available",
      [owner, amount],
    );
  }
  await db.query("COMMIT");
  console.log("Credit grant recorded");
} catch {
  await db.query("ROLLBACK");
  console.error("Credit grant failed");
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
