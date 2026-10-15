import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";

const LOCK = 71324001;

/**
 * Apply the pinned Better Auth schema, then the budget/job tables, under one
 * advisory lock so concurrently starting containers never migrate at once.
 * The lock serialises execution only; schema changes must stay compatible with
 * the release that is still serving.
 */
export async function migrate() {
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
    await lock.query("SELECT pg_advisory_lock($1)", [LOCK]);
    const migration = await getMigrations({
      database: pool,
      rateLimit: { storage: "database" },
      logger: { disabled: true },
    });
    await migration.runMigrations();
    await lock.query("BEGIN");
    await lock.query(
      await readFile(new URL("../db/migrations/001-video-budgets.sql", import.meta.url), "utf8"),
    );
    await lock.query("COMMIT");
  } catch {
    await lock.query("ROLLBACK").catch(() => {});
    throw new Error("Migration failed; inspect the database privately before retrying");
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    lock.release();
    await pool.end();
  }
}
