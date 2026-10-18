import { describe, expect, it, vi } from "vitest";
import {
  classifyProviderError,
  downloadVideo,
  generationPayload,
  pollGeneration,
  ProviderError,
  submitGeneration,
  verifyGoogleModel,
} from "../src/lib/video/providers";
import { estimateUsd, type GenerationInput, validateGeneration } from "../src/lib/video/schema";
const input: GenerationInput = {
  provider: "google",
  model: "veo-3.1-fast-generate-preview",
  prompt: "A small blue robot walks in place on green.",
  durationSeconds: 4,
  resolution: "720p",
  aspectRatio: "16:9",
};
const image = {
  mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};
const mp4 = Buffer.from([
  0,
  0,
  0,
  20,
  ...Buffer.from("ftypisom"),
  0,
  0,
  0,
  0,
  ...Buffer.from("isom"),
]);

describe("video provider contracts", () => {
  it("sends Google first and last frames using the Gemini SDK wire format", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ name: "models/veo-3.1-lite-generate-preview/operations/test" }),
      );
    const operation = await submitGeneration(
      {
        ...input,
        model: "veo-3.1-lite-generate-preview",
        firstFrame: image,
        lastFrame: image,
      },
      "fake-google-api-key",
      { transport },
    );
    const [url, request] = transport.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite-generate-preview:predictLongRunning",
    );
    expect(request?.headers).toMatchObject({ "x-goog-api-key": "fake-google-api-key" });
    expect(JSON.parse(request?.body as string)).toEqual({
      instances: [
        {
          prompt: input.prompt,
          image: { bytesBase64Encoded: image.data, mimeType: image.mimeType },
          lastFrame: { bytesBase64Encoded: image.data, mimeType: image.mimeType },
        },
      ],
      parameters: { aspectRatio: "16:9", durationSeconds: 4, resolution: "720p" },
    });
    expect(request?.body).not.toContain("inlineData");
    expect(operation).toEqual({
      provider: "google",
      id: "models/veo-3.1-lite-generate-preview/operations/test",
    });
  });
  it("sends Google asset references using the same SDK image wire format", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ name: "operations/test-references" }));
    await submitGeneration(
      { ...input, durationSeconds: 8, referenceImages: [image] },
      "fake-google-api-key",
      { transport },
    );
    const request = transport.mock.calls[0][1];
    expect(JSON.parse(request?.body as string)).toEqual({
      instances: [
        {
          prompt: input.prompt,
          referenceImages: [
            {
              image: { bytesBase64Encoded: image.data, mimeType: image.mimeType },
              referenceType: "asset",
            },
          ],
        },
      ],
      parameters: { aspectRatio: "16:9", durationSeconds: 8, resolution: "720p" },
    });
    expect(request?.body).not.toContain("inlineData");
  });
  it("supports xAI first/last frames and references through data URIs", async () => {
    const generation: GenerationInput = {
      ...input,
      provider: "xai",
      model: "grok-imagine-video-1.5",
      firstFrame: image,
      lastFrame: image,
      referenceImages: [image],
    };
    const payload = generationPayload(generation);
    expect(payload).toMatchObject({
      generate_audio: false,
      image: { url: `data:image/png;base64,${image.data}` },
      last_frame: { url: `data:image/png;base64,${image.data}` },
      reference_images: [{ url: `data:image/png;base64,${image.data}` }],
    });
    expect(estimateUsd(generation)).toBe(0.59);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ request_id: "test-operation" }));
    expect(await submitGeneration(generation, "fake-xai-api-key", { transport })).toEqual({
      provider: "xai",
      id: "test-operation",
    });
  });
  it("rejects unsupported combinations before any paid request", () => {
    expect(() => validateGeneration({ ...input, referenceImages: [image] })).toThrow("8 seconds");
    expect(() =>
      validateGeneration({
        ...input,
        durationSeconds: 8,
        firstFrame: image,
        referenceImages: [image],
      }),
    ).toThrow("Choose reference images");
    expect(() =>
      validateGeneration({
        ...input,
        provider: "xai",
        model: "grok-imagine-video-1.5-lite",
        lastFrame: image,
      }),
    ).toThrow("end frame");
    expect(() =>
      validateGeneration({
        ...input,
        provider: "xai",
        model: "grok-imagine-video-1.5",
        lastFrame: image,
        resolution: "1080p",
      }),
    ).toThrow("720p");
    expect(() =>
      validateGeneration({
        ...input,
        firstFrame: { ...image, data: "https://example.test/private.png" },
      }),
    ).toThrow("Invalid generation");
  });
  it("parses provider completion and never reflects upstream error bodies", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
                },
              },
            ],
          },
        },
      }),
    );
    expect(
      await pollGeneration({ provider: "google", id: "operations/test" }, "fake-key", {
        transport,
      }),
    ).toMatchObject({ status: "done" });
    transport.mockResolvedValue(
      new Response("fake-sensitive-provider-diagnostic", { status: 400 }),
    );
    await expect(submitGeneration(input, "fake-key", { transport })).rejects.toThrow(
      "provider declined",
    );
    transport.mockRejectedValue(new Error("fake-sensitive-network-diagnostic"));
    const error = await submitGeneration(input, "fake-key", { transport }).catch((error) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.uncertain).toBe(true);
    expect(error.message).not.toContain("sensitive");
  });
  it.each([
    [400, "video controls"],
    [401, "API key in local setup"],
    [402, "required prepayment"],
    [403, "key permissions"],
    [404, "model availability"],
    [429, "quota"],
    [503, "reserved budget is held"],
  ])(
    "diagnoses HTTP %i without exposing provider diagnostics or retrying",
    async (status, hint) => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("fake-sensitive-provider-body", {
          status,
          statusText: "fake-sensitive-provider-status-text",
        }),
      );
      const error = await submitGeneration(input, "fake-sensitive-api-key", { transport }).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain(hint);
      expect(error.message).not.toContain("sensitive");
      expect(error.uncertain).toBe(status >= 500);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["API_KEY_INVALID", "rejected the API key"],
    ["API_KEY_SERVICE_BLOCKED", "service restrictions"],
    ["API_KEY_HTTP_REFERRER_BLOCKED", "website restrictions"],
    ["API_KEY_IP_ADDRESS_BLOCKED", "IP address restrictions"],
    ["SERVICE_DISABLED", "Enable the Gemini API"],
    ["BILLING_DISABLED", "billing and required prepayment"],
  ])("classifies Google %s without exposing echoed inputs or metadata", async (reason, hint) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            message: "fake-private-prompt fake-private-key",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason,
                metadata: { key: "fake-private-key", prompt: "fake-private-prompt" },
              },
            ],
          },
        },
        { status: 400 },
      ),
    );
    const error = await submitGeneration(input, "fake-private-key", { transport }).catch(
      (error) => error,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain(hint);
    expect(error.message).not.toContain("fake-private");
    expect(error.message).not.toContain(reason);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["API key not valid. fake-private-key", "rejected the API key"],
    [
      "Your prepayment credits are depleted. fake-private-account",
      "positive Gemini API prepay balance",
    ],
    ["Billing is disabled. fake-private-account", "billing and required prepayment"],
    [
      "Your use case is currently not supported. fake-private-prompt",
      "combination of model, duration",
    ],
    ["lastFrame requires 8 seconds. fake-private-prompt", "requires 8 seconds"],
    [
      'Invalid JSON payload received. Unknown name "fake-private-field"',
      "rejected a request field",
    ],
    ["inlineData isn't supported by this model. fake-private-image", "image payload format"],
    ["Unable to decode the input image. fake-private-image", "valid PNG or JPEG"],
    [
      "Requested resolution is not supported. fake-private-prompt",
      "rejected the requested resolution",
    ],
    ["Invalid durationSeconds. fake-private-prompt", "rejected the requested duration"],
  ])("maps a recognized Google diagnostic to authored guidance: %s", (message, hint) => {
    const result = classifyProviderError("google", { error: { message } });
    expect(result).toContain(hint);
    expect(result).not.toContain("fake-private");
  });
  it("ignores unrecognized reasons, arbitrary messages, and xAI diagnostic bodies", () => {
    const payload = {
      error: {
        message: "fake-private-prompt-and-key",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "fake-private-reason",
            metadata: { key: "fake-private-key" },
          },
        ],
      },
    };
    expect(classifyProviderError("google", payload)).toBeUndefined();
    expect(
      classifyProviderError("google", { error: { message: "x".repeat(5000) } }),
    ).toBeUndefined();
    expect(classifyProviderError("google", null)).toBeUndefined();
    expect(
      classifyProviderError("xai", { error: { message: "API key not valid." } }),
    ).toBeUndefined();
  });
  it("falls back safely for malformed, oversized, or broken provider error streams", async () => {
    const responses = [
      new Response("fake-private-not-json", { status: 400 }),
      new Response(JSON.stringify({ error: { message: "x".repeat(17 * 1024) } }), { status: 400 }),
      new Response("fake-private-body", { status: 400, headers: { "content-length": "20000" } }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("fake-private-stream-error"));
          },
        }),
        { status: 400 },
      ),
    ];
    for (const response of responses) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await submitGeneration(input, "fake-private-key", { transport }).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toContain("HTTP 400");
      expect(error.message).toContain("video controls");
      expect(error.message).not.toContain("fake-private");
      expect(error.uncertain).toBe(false);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it("reads Google model metadata with a header key and returns only safe capability booleans", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        name: `models/${input.model}`,
        supportedGenerationMethods: ["predictLongRunning"],
        description: "fake-private-description",
        metadata: { key: "fake-private-key" },
      }),
    );
    expect(await verifyGoogleModel(input.model, "fake-private-key", { transport })).toEqual({
      available: true,
      supportsGeneration: true,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${input.model}`);
    expect(String(url)).not.toContain("fake-private-key");
    expect(request).toMatchObject({
      method: "GET",
      headers: { "x-goog-api-key": "fake-private-key" },
      redirect: "error",
    });
    expect(request?.body).toBeUndefined();
  });
  it("does not infer model generation capability from missing or malformed metadata", async () => {
    for (const methods of [undefined, ["generateContent"], ["predictLongRunning", 42]]) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ name: `models/${input.model}`, supportedGenerationMethods: methods }),
        );
      expect(await verifyGoogleModel(input.model, "fake-key", { transport })).toEqual({
        available: true,
        supportsGeneration: false,
      });
    }
  });
  it("rejects arbitrary Google model paths before sending credentials", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const model of ["../private", "https://attacker.example", "grok-imagine-video-1.5"]) {
      await expect(verifyGoogleModel(model, "fake-key", { transport })).rejects.toThrow(
        "supported Google video model",
      );
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses the same safe diagnostics for Google model checks and hides invalid metadata", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: "API key not valid. fake-private-key" } },
          { status: 400 },
        ),
      );
    const error = await verifyGoogleModel(input.model, "fake-private-key", { transport }).catch(
      (error) => error,
    );
    expect(error.message).toContain("model access check failed (HTTP 400)");
    expect(error.message).toContain("rejected the API key");
    expect(error.message).not.toContain("fake-private");
    transport.mockResolvedValue(Response.json({ name: "models/fake-private-name" }));
    await expect(verifyGoogleModel(input.model, "fake-key", { transport })).rejects.toThrow(
      "invalid model metadata",
    );
    transport.mockRejectedValue(new Error("fake-private-network-error"));
    await expect(verifyGoogleModel(input.model, "fake-key", { transport })).rejects.toThrow(
      "model access check is temporarily unavailable",
    );
  });
  it("does not forward Google keys to allowed storage redirects", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://storage.googleapis.com/test/video.mp4" },
        }),
      )
      .mockResolvedValueOnce(new Response(mp4, { headers: { "content-type": "video/mp4" } }));
    expect(
      await downloadVideo(
        "google",
        "https://generativelanguage.googleapis.com/v1beta/files/test:download",
        "fake-google-api-key",
        { transport },
      ),
    ).toEqual(mp4);
    expect(transport.mock.calls[0][1]?.headers).toEqual({
      "x-goog-api-key": "fake-google-api-key",
    });
    expect(transport.mock.calls[1][1]?.headers).toEqual({});
  });
  it("rejects hostile download hosts, redirect escapes, wrong MIME and huge responses", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/private" },
      }),
    );
    await expect(
      downloadVideo("xai", "http://127.0.0.1/private", "fake-key", { transport }),
    ).rejects.toThrow("not permitted");
    expect(transport).not.toHaveBeenCalled();
    await expect(
      downloadVideo("xai", "https://vidgen.x.ai/video.mp4", "fake-key", { transport }),
    ).rejects.toThrow("not permitted");
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockResolvedValue(new Response("html", { headers: { "content-type": "text/html" } }));
    await expect(
      downloadVideo("xai", "https://vidgen.x.ai/video.mp4", "fake-key", { transport }),
    ).rejects.toThrow("MP4");
    transport.mockResolvedValue(
      new Response(mp4, { headers: { "content-length": String(65 * 1024 * 1024) } }),
    );
    await expect(
      downloadVideo("xai", "https://vidgen.x.ai/video.mp4", "fake-key", { transport }),
    ).rejects.toThrow("size limit");
  });
});
