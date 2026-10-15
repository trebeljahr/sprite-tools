import type { Request, Response } from "express";
import { PAID_VIDEO_UNAVAILABLE } from "../xai.js";

// Paid video stays off. Answer before reading the upload: no session lookup, no
// body parsing, no provider call. The client-side AuthWall is only a UI
// placeholder. Re-enabling requires server authentication, job ownership and
// atomic budgets (see docs/accounts-operations.md).
export function videoUnavailable(_req: Request, res: Response) {
  res
    .status(503)
    .set({ "Cache-Control": "no-store", Connection: "close" })
    .json({ success: false, error: PAID_VIDEO_UNAVAILABLE });
}
