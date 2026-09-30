import { requireAccount } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await requireAccount();
    const budget = await getDatabase().query(
      "SELECT available,reserved,spent FROM video_budgets WHERE owner_id=$1",
      [user.id],
    );
    return Response.json(
      {
        name: user.name,
        credits: Number(budget.rows[0]?.available ?? 0),
        reserved: Number(budget.rows[0]?.reserved ?? 0),
        spent: Number(budget.rows[0]?.spent ?? 0),
        paidVideoEnabled: false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Sign in or try again later" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
}
