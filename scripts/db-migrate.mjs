import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { readFile } from "node:fs/promises";

if (
  !(
    process.env.POSTGRES_URL ||
    (process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  )
)
  throw new Error("POSTGRES_URL is required");
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 2 });
const lock = await pool.connect();
try {
  await lock.query("SELECT pg_advisory_lock(71324001)");
  // Better Auth owns its schema; pinned dependency supplies the migration.
  const migration = await getMigrations({ database: pool, rateLimit: { storage: "database" } });
  await migration.runMigrations();
  await lock.query("BEGIN");
  await lock.query(
    await readFile(new URL("../db/migrations/001-video-budgets.sql", import.meta.url), "utf8"),
  );
  await lock.query("COMMIT");
  console.log("Account and budget schema ready");
} catch {
  await lock.query("ROLLBACK");
  console.error("Migration failed; inspect the database privately before retrying");
  process.exitCode = 1;
} finally {
  await lock.query("SELECT pg_advisory_unlock(71324001)");
  lock.release();
  await pool.end();
}
