import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * pg emits "error" on the pool when an idle client's connection dies, for
 * example when Postgres restarts or its container is recreated. Without a
 * listener Node treats it as an unhandled error event and exits. The pool has
 * already discarded the dead client, so logging is enough: the next checkout
 * opens a fresh connection. Errors on active queries still reject the query.
 */
export function logIdleClientErrors(target: Pool, label = "db") {
  target.on("error", (error) => {
    console.error(`[${label}] Idle database client failed: ${error.message}`);
  });
  return target;
}

export function getDatabase() {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString &&
    !(process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  )
    throw new Error("Account database is not configured");
  pool ??= logIdleClientErrors(
    new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    }),
  );
  return pool;
}

export async function closeDatabase() {
  const current = pool;
  pool = undefined;
  await current?.end();
}
