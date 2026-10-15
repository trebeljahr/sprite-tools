import type { Request, Response } from "express";
import { getAuth } from "../auth.js";
import { commitSha } from "../config/env.js";
import { getDatabase } from "../db.js";
import { isDraining, isLoopback } from "../drain.js";

const NO_STORE = { "Cache-Control": "no-store" };

/** Account configuration and the PostgreSQL schema, without reading user rows. */
export async function accountsReady(): Promise<boolean> {
  try {
    getAuth();
    const readinessQuery = {
      query_timeout: 2000,
      text: `SELECT
      to_regclass('public.user') IS NOT NULL AND
      to_regclass('public.session') IS NOT NULL AND
      to_regclass('public.account') IS NOT NULL AND
      to_regclass('public.verification') IS NOT NULL AND
      to_regclass('public."rateLimit"') IS NOT NULL AND
      to_regclass('public.video_budgets') IS NOT NULL AND
      to_regclass('public.video_jobs') IS NOT NULL AS ready`,
    };
    const result = await getDatabase().query(readinessQuery);
    return result.rows[0]?.ready === true;
  } catch {
    return false;
  }
}

// Only the in-container probe sees the drain; a release check from outside
// still gets the real answer from a draining container.
function drainingProbe(req: Request) {
  return isDraining() && isLoopback(req.socket.remoteAddress);
}

/** Coolify's health check. Same contract as the Next route it replaces. */
export async function accountsHealth(req: Request, res: Response) {
  const ready = !drainingProbe(req) && (await accountsReady());
  res
    .status(ready ? 200 : 503)
    .set(NO_STORE)
    .json({ ready });
}

/** The release check: readiness plus the commit this image was built from. */
export async function health(req: Request, res: Response) {
  const ready = !drainingProbe(req) && (await accountsReady());
  res
    .status(ready ? 200 : 503)
    .set(NO_STORE)
    .json({ ready, version: commitSha() });
}
