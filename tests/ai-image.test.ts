import { describe, expect, it, vi } from "vitest";
import { formatUsd, generateWithCredit, generateWithOwnKey } from "@/lib/ai-image";

// A 1×1 PNG, base64.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("generateWithOwnKey", () => {
  it("sends the prompt and the key straight to xAI and returns the sprite", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ b64_json: PNG }] }));
    const image = await generateWithOwnKey(
      { apiKey: " xai-own-key ", model: "grok-imagine-image", prompt: "a knight" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(image).toBe(`data:image/png;base64,${PNG}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Only xAI ever sees the key: no call to the sprite-tools server.
    expect(url).toBe("https://api.x.ai/v1/images/generations");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xai-own-key");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "grok-imagine-image",
      prompt: "a knight",
      n: 1,
      response_format: "b64_json",
    });
  });

  it("passes xAI's error message on", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "Incorrect API key provided" }, { status: 400 }),
    );
    await expect(
      generateWithOwnKey(
        { apiKey: "bad", model: "grok-imagine-image", prompt: "a knight" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("xAI refused the request: Incorrect API key provided");
  });
});

describe("generateWithCredit", () => {
  it("asks the sprite-tools server and passes its error on", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "Not enough AI credit for this image." }, { status: 402 }),
    );
    await expect(
      generateWithCredit(
        { model: "grok-imagine-image", prompt: "a knight", requestKey: crypto.randomUUID() },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Not enough AI credit for this image.");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/api/generate/image");
  });
});

describe("formatUsd", () => {
  it("shows cents, and a third digit only below a cent", () => {
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(0.02)).toBe("$0.02");
    expect(formatUsd(0.026)).toBe("$0.026");
    expect(formatUsd(4.974)).toBe("$4.974");
  });
});
