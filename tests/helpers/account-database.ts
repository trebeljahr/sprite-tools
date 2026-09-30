import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

// PGlite is single-connection PostgreSQL. Queue checkouts so transactions cannot
// interleave in the test harness. Production uses pg with database row locks.
export function testDatabase() {
  const database = new PGlite();
  let tail = Promise.resolve();
  async function query(sql: string, params?: unknown[]) {
    const result = await database.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: sql.split(" ")[0],
    };
  }
  const pool = {
    async connect() {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      return { query, release };
    },
    async query(sql: string, params?: unknown[]) {
      const client = await this.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
    async end() {},
  };
  return { database, pool: pool as unknown as Pool };
}
