import { getAuth } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
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
    if (!result.rows[0]?.ready) throw new Error("Schema unavailable");
    return Response.json({ ready: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { ready: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
