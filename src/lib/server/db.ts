import "server-only";
import { Pool } from "pg";

let pool: Pool | undefined;
export function getDatabase() {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString &&
    !(process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  )
    throw new Error("Account database is not configured");
  pool ??= new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  return pool;
}
