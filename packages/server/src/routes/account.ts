import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { requireAccount } from "../auth.js";
import { getDatabase } from "../db.js";

const NO_STORE = { "Cache-Control": "no-store" };

export async function account(req: Request, res: Response) {
  try {
    const user = await requireAccount(fromNodeHeaders(req.headers));
    const budget = await getDatabase().query(
      "SELECT available,reserved,spent FROM video_budgets WHERE owner_id=$1",
      [user.id],
    );
    res.set(NO_STORE).json({
      name: user.name,
      credits: Number(budget.rows[0]?.available ?? 0),
      reserved: Number(budget.rows[0]?.reserved ?? 0),
      spent: Number(budget.rows[0]?.spent ?? 0),
      paidVideoEnabled: false,
    });
  } catch {
    res.status(401).set(NO_STORE).json({ error: "Sign in or try again later" });
  }
}
