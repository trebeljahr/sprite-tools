import "server-only";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

// Credits are operator-defined units, not a claim about provider dollar prices.
export class VideoLedger {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async reserve(owner: string, requestKey: string, cost: number) {
    if (
      !owner ||
      owner === "__global__" ||
      !Number.isSafeInteger(cost) ||
      cost <= 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)
    )
      throw new Error("Invalid reservation");
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      // Consistent global-first lock order serializes reservations across replicas.
      await db.query("SELECT owner_id FROM video_budgets WHERE owner_id='__global__' FOR UPDATE");
      const existing = await db.query(
        "SELECT id,cost,status FROM video_jobs WHERE owner_id=$1 AND request_key=$2",
        [owner, requestKey],
      );
      if (existing.rows[0]) {
        if (Number(existing.rows[0].cost) !== cost) throw new Error("Reservation conflict");
        await db.query("COMMIT");
        return { id: existing.rows[0].id as string, created: false };
      }
      const active = await db.query(
        "SELECT id FROM video_jobs WHERE owner_id=$1 AND status IN ('reserved','submitted','uncertain')",
        [owner],
      );
      if (active.rowCount) throw new Error("A generation is already active");
      for (const account of ["__global__", owner]) {
        const updated = await db.query(
          "UPDATE video_budgets SET available=available-$2,reserved=reserved+$2 WHERE owner_id=$1 AND available >= $2 RETURNING owner_id",
          [account, cost],
        );
        if (!updated.rowCount) throw new Error("Insufficient generation credits");
      }
      const id = randomUUID();
      await db.query("INSERT INTO video_jobs(id,owner_id,request_key,cost) VALUES($1,$2,$3,$4)", [
        id,
        owner,
        requestKey,
        cost,
      ]);
      await db.query("COMMIT");
      return { id, created: true };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async ownedJob(owner: string, id: string) {
    const result = await this.pool.query(
      "SELECT id,status,provider_id,cost FROM video_jobs WHERE id=$1 AND owner_id=$2",
      [id, owner],
    );
    if (!result.rows[0]) throw new Error("Generation not found");
    return result.rows[0] as {
      id: string;
      status: string;
      provider_id: string | null;
      cost: string;
    };
  }

  // Commit the full reservation conservatively, including uncertain dispatch.
  // No automatic refund: a timeout does not establish that the provider did not bill.
  async settle(owner: string, id: string, outcome: "done" | "failed") {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT owner_id FROM video_budgets WHERE owner_id='__global__' FOR UPDATE");
      const result = await db.query(
        "SELECT cost,status FROM video_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [id, owner],
      );
      const job = result.rows[0];
      if (!job) throw new Error("Generation not found");
      if (!["done", "failed"].includes(job.status)) {
        for (const account of ["__global__", owner]) {
          const updated = await db.query(
            "UPDATE video_budgets SET reserved=reserved-$2,spent=spent+$2 WHERE owner_id=$1 AND reserved >= $2 RETURNING owner_id",
            [account, job.cost],
          );
          if (!updated.rowCount) throw new Error("Budget ledger mismatch");
        }
        await db.query("UPDATE video_jobs SET status=$3 WHERE id=$1 AND owner_id=$2", [
          id,
          owner,
          outcome,
        ]);
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
