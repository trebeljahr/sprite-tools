import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

// Longer than any image request (90 s) plus the shutdown drain.
export const STALE_RESERVATION_MINUTES = 10;

// The AI credit ledger for hosted generation. Amounts are integer
// micro-dollars (1,000,000 = US$1): bought through Stripe or granted by an
// operator. The table names still say "video" because video came first;
// image generation uses the same budgets and jobs.
export class VideoLedger {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async reserve(
    owner: string,
    requestKey: string,
    cost: number,
    metadata?: { model: string; provider: string },
  ) {
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
      // A reservation older than any request can run was stranded by a
      // crash, a deploy or a failed ledger write after dispatch. The provider
      // may have billed it, so it is charged, as a timeout would be.
      const stale = await db.query(
        `SELECT id,cost FROM video_jobs WHERE owner_id=$1 AND status='reserved' AND created_at < now() - interval '${STALE_RESERVATION_MINUTES} minutes' FOR UPDATE`,
        [owner],
      );
      for (const job of stale.rows) {
        for (const account of ["__global__", owner]) {
          const updated = await db.query(
            "UPDATE video_budgets SET reserved=reserved-$2,spent=spent+$2 WHERE owner_id=$1 AND reserved >= $2 RETURNING owner_id",
            [account, job.cost],
          );
          if (!updated.rowCount) throw new Error("Budget ledger mismatch");
        }
        await db.query(
          "UPDATE video_jobs SET status='failed',billing_status='charged' WHERE id=$1",
          [job.id],
        );
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
      await db.query(
        "INSERT INTO video_jobs(id,owner_id,request_key,cost,model,provider) VALUES($1,$2,$3,$4,$5,$6)",
        [id, owner, requestKey, cost, metadata?.model ?? null, metadata?.provider ?? null],
      );
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

  // Give a reservation back when the provider answered with an error, so
  // nothing was made and nothing was billed.
  async release(owner: string, id: string) {
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
            "UPDATE video_budgets SET reserved=reserved-$2,available=available+$2 WHERE owner_id=$1 AND reserved >= $2 RETURNING owner_id",
            [account, job.cost],
          );
          if (!updated.rowCount) throw new Error("Budget ledger mismatch");
        }
        await db.query(
          "UPDATE video_jobs SET status='failed',billing_status='refunded' WHERE id=$1 AND owner_id=$2",
          [id, owner],
        );
      }
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  // Add bought credit once per Checkout Session, whatever Stripe retries. The
  // global pool grows by the same amount, so bought credit is always spendable.
  async grantPurchase(purchase: {
    sessionId: string;
    ownerId: string;
    creditMicros: number;
    paidCents: number;
  }): Promise<boolean> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT owner_id FROM video_budgets WHERE owner_id='__global__' FOR UPDATE");
      const inserted = await db.query(
        "INSERT INTO credit_purchases(checkout_session_id,owner_id,credit_micros,paid_cents) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING checkout_session_id",
        [purchase.sessionId, purchase.ownerId, purchase.creditMicros, purchase.paidCents],
      );
      if (inserted.rowCount) {
        await db.query(
          "INSERT INTO video_budgets(owner_id,available) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET available=video_budgets.available+EXCLUDED.available",
          [purchase.ownerId, purchase.creditMicros],
        );
        await db.query(
          "UPDATE video_budgets SET available=available+$1 WHERE owner_id='__global__'",
          [purchase.creditMicros],
        );
      }
      await db.query("COMMIT");
      return Boolean(inserted.rowCount);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
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
        await db.query(
          "UPDATE video_jobs SET status=$3,billing_status='charged' WHERE id=$1 AND owner_id=$2",
          [id, owner, outcome],
        );
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
