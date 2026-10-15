import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { generateVideo, PAID_VIDEO_UNAVAILABLE, pollVideoStatus } from "../src/xai";

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Sends headers and the first bytes of an upload, then waits for the answer
// without ever finishing the body: a reply proves the server did not read it.
function unfinishedUpload(path: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "1000000" },
    });
    req.on("response", (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
      });
    });
    req.on("error", reject);
    req.write("--x\r\n");
  });
}

describe("paid video containment", () => {
  for (const configured of [false, true]) {
    it(`denies every entry point with provider configuration ${configured}`, async () => {
      vi.stubEnv("XAI_API_KEY", configured ? "fake-test-key" : undefined);
      vi.stubEnv("NEXT_PUBLIC_ENABLE_AI", "true");
      const call = globalThis.fetch;
      const network = vi.fn(() => {
        throw new Error("Unexpected network access");
      });
      vi.stubGlobal("fetch", network);
      const failure = { success: false, error: PAID_VIDEO_UNAVAILABLE };

      expect(await unfinishedUpload("/api/video/generations")).toEqual({
        status: 503,
        body: failure,
      });
      const status = await call(`${origin}/api/video/generations/another-users-job`);
      expect(status.status).toBe(503);
      expect(await status.json()).toEqual(failure);
      await expect(generateVideo("unused-image", "unused-prompt")).rejects.toThrow(
        PAID_VIDEO_UNAVAILABLE,
      );
      await expect(pollVideoStatus("another-users-job")).rejects.toThrow(PAID_VIDEO_UNAVAILABLE);
      expect(network).not.toHaveBeenCalled();
    });
  }
});
