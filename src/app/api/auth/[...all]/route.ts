import { getAuth } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  try {
    return await getAuth().handler(request);
  } catch {
    return Response.json({ message: "Accounts are temporarily unavailable" }, { status: 503 });
  }
}
export { handle as GET, handle as POST };
