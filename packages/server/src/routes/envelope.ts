import { Readable } from "node:stream";
import { fromNodeHeaders } from "better-auth/node";
import type { Request, Response } from "express";
import { createEnvelopeTunnel } from "../envelope-tunnel.js";

// The browser bundle and this tunnel share one public DSN. Unset means error
// reporting is off and the tunnel answers 503.
const tunnel = createEnvelopeTunnel(
  () => process.env.NEXT_PUBLIC_GLITCHTIP_DSN,
  () => process.env.BETTER_AUTH_URL ?? "",
);

/** POST /api/_e: hands the raw request stream to the fetch-style tunnel. */
export async function envelope(req: Request, res: Response) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const response = await tunnel(
    new globalThis.Request(new URL(req.originalUrl, "http://localhost"), {
      method: req.method,
      headers: fromNodeHeaders(req.headers),
      body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit),
  );
  res.status(response.status);
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end();
}
