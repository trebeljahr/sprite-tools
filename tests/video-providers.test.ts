import { describe, expect, it, vi } from "vitest";
import {
  downloadVideo,
  generationPayload,
  pollGeneration,
  ProviderError,
  submitGeneration,
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
  it("uses Google's long-running API and inline frames, with no unsupported sampleCount", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ name: "models/veo-3.1-fast-generate-preview/operations/test" }),
      );
    const operation = await submitGeneration(
      { ...input, firstFrame: image, lastFrame: image },
      "fake-google-api-key",
      { transport },
    );
    const [url, request] = transport.mock.calls[0];
    expect(String(url)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning",
    );
    expect(request?.headers).toMatchObject({ "x-goog-api-key": "fake-google-api-key" });
    expect(JSON.parse(request?.body as string)).toEqual({
      instances: [
        {
          prompt: input.prompt,
          image: { inlineData: { mimeType: image.mimeType, data: image.data } },
          lastFrame: { inlineData: { mimeType: image.mimeType, data: image.data } },
        },
      ],
      parameters: { aspectRatio: "16:9", durationSeconds: 4, resolution: "720p" },
    });
    expect(operation).toEqual({
      provider: "google",
      id: "models/veo-3.1-fast-generate-preview/operations/test",
    });
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
