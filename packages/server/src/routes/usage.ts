import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { requireAccount } from "../auth.js";
import { getDatabase } from "../db.js";

export async function usage(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  let owner: string;
  try {
    owner = (await requireAccount(fromNodeHeaders(req.headers))).id;
  } catch {
    return res.status(401).json({ error: "Sign in to view credit usage." });
  }
  const page = Number(req.query.page ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
    return res.status(400).json({ error: "Invalid history page." });
  const db = await getDatabase().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const budget = await db.query(
      "SELECT available,reserved,spent FROM video_budgets WHERE owner_id=$1",
      [owner],
    );
    const groups = await db.query(
      `SELECT model,provider,count(*)::int AS count,
        coalesce(sum(cost) FILTER (WHERE billing_status='charged'),0) AS charged,
        count(*) FILTER (WHERE status='failed' AND billing_status IS NULL)::int AS unknown
       FROM video_jobs WHERE owner_id=$1 GROUP BY model,provider ORDER BY charged DESC,model`,
      [owner],
    );
    const jobs = await db.query(
      `SELECT id,model,provider,status,billing_status,cost,created_at
       FROM video_jobs WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $2`,
      [owner, page * 50],
    );
    // Full-history daily aggregates; independent of the paginated detail table.
    const activity = await db.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
        model,provider,status,count(*)::int AS requests,
        coalesce(sum(cost) FILTER (WHERE billing_status='charged'),0) AS cost,
        count(*) FILTER (WHERE status='failed' AND billing_status IS NULL)::int AS unknown
       FROM video_jobs WHERE owner_id=$1
       GROUP BY day,model,provider,status ORDER BY day`,
      [owner],
    );
    await db.query("COMMIT");
    const row = budget.rows[0];
    return res.json({
      balanceMicros: Number(row?.available ?? 0),
      reservedMicros: Number(row?.reserved ?? 0),
      spentMicros: Number(row?.spent ?? 0),
      total: groups.rows.reduce((sum, group) => sum + group.count, 0),
      unknownCount: groups.rows.reduce((sum, group) => sum + group.unknown, 0),
      models: groups.rows.map((group) => ({
        model: group.model,
        provider: group.provider,
        count: group.count,
        chargedMicros: Number(group.charged),
      })),
      activity: activity.rows.map((row) => ({
        day: row.day,
        model: row.model ?? "Not recorded",
        provider: row.provider ?? "Unknown",
        status: row.status,
        requests: row.requests,
        completed: row.status === "done" ? row.requests : 0,
        costMicros: Number(row.cost),
        unknownCosts: row.unknown,
      })),
      page,
      jobs: jobs.rows.map((job) => ({
        id: job.id,
        model: job.model,
        provider: job.provider,
        status: job.status,
        billingStatus: job.billing_status,
        costMicros: Number(job.cost),
        createdAt: job.created_at,
      })),
    });
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
