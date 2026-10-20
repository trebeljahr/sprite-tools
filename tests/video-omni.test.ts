import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadOmniVideo,
  generationPayload,
  pollGeneration,
  preflightGoogleOmni,
  submitGeneration,
  validateOmniDownloadUrl,
} from "../src/lib/video/providers";
import {
  GOOGLE_OMNI_MODEL,
  VIDEO_MODELS,
  estimateUsd,
  validateGeneration,
} from "../src/lib/video/schema";
import { createVideoService, type VideoService } from "../src/lib/video/service";

const png = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
const jpeg = { mimeType: "image/jpeg" as const, data: "/9j/2Q==" };
const input = {
  provider: "google" as const,
  model: GOOGLE_OMNI_MODEL,
  prompt: "A robot walks in place.",
  durationSeconds: 3,
  resolution: "720p" as const,
  aspectRatio: "16:9",
  firstFrame: png,
  lastFrame: jpeg,
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
const fileUrl =
  "https://generativelanguage.googleapis.com/v1beta/files/video-123:download?alt=media";
const operation = { provider: "google" as const, kind: "interaction" as const, id: "v1_saved_123" };
const interaction = (status = "in_progress", video?: Record<string, unknown>) => ({
  id: operation.id,
  object: "interaction",
  model: GOOGLE_OMNI_MODEL,
  status,
  ...(video
    ? {
        steps: [
          { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", ...video }] },
        ],
      }
    : {}),
});
const directories: string[] = [];
const services: VideoService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function localService(network: typeof fetch, enabled = false, existing?: string) {
  const stateDir = existing ?? (await mkdtemp(join(tmpdir(), "sprite-omni-test-")));
  if (!directories.includes(stateDir)) directories.push(stateDir);
  const service = await createVideoService({
    stateDir,
    enableGoogleOmni: enabled,
    transport: network,
    pollIntervalMs: 5,
    maxPollMs: 200,
    processVideo: async ({ videoPath, outputDir }) => {
      const sheetPath = join(outputDir, "sheet.png"),
        metadataPath = join(outputDir, "metadata.json");
      await writeFile(sheetPath, "fake PNG");
      await writeFile(metadataPath, "{}");
      return { videoPath, sheetPath, metadataPath };
    },
  });
  services.push(service);
  await service.unlock("test-only-omni-passphrase");
  if (!existing) {
    await service.setCredential("google", "fake-omni-key");
    await service.setBudget({ limitUsd: 1, perJobUsd: 0.5 });
  }
  return { service, stateDir };
}

describe("offline Omni adapter", () => {
  it("supports only the bounded initial controls and uses a fixed reservation estimate", () => {
    expect(VIDEO_MODELS.find((model) => model.provider === "google")?.id).toBe(
      "veo-3.1-fast-generate-preview",
    );
    expect(validateGeneration(input)).toEqual(input);
    expect(estimateUsd(input)).toBe(0.5);
    for (const changed of [
      { durationSeconds: 4 },
      { resolution: "1080p" },
      { referenceImages: [png] },
      { firstFrame: undefined },
    ])
      expect(() => validateGeneration({ ...input, ...changed })).toThrow();
    expect(() => validateGeneration({ ...input, max_output_tokens: 100 })).toThrow();
  });

  it("allows the free metadata check with paid Omni disabled and leaves entitlement unknown", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        name: `models/${GOOGLE_OMNI_MODEL}`,
        supportedGenerationMethods: ["generateContent"],
      }),
    );
    const { service } = await localService(network);
    expect(await service.verifyGoogleModel(GOOGLE_OMNI_MODEL)).toMatchObject({
      available: true,
      supportsGeneration: null,
      note: expect.stringContaining("does not verify"),
    });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1]?.method).toBe("GET");
    expect((await service.status()).jobs).toEqual([]);
    expect((await service.status()).budget.committedUsd).toBe(0);
  });

  it("counts the exact ordered images and final text before one fresh bounded interaction", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ totalTokens: 10_000 }))
      .mockResolvedValueOnce(Response.json(interaction()));
    expect(
      await submitGeneration(input, "fake-key", { transport: network, enableGoogleOmni: true }),
    ).toEqual(operation);
    expect(network).toHaveBeenCalledTimes(2);
    expect(String(network.mock.calls[0][0])).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_OMNI_MODEL}:countTokens`,
    );
    const count = JSON.parse(String(network.mock.calls[0][1]?.body));
    const sent = JSON.parse(String(network.mock.calls[1][1]?.body));
    expect(sent).toEqual({
      model: GOOGLE_OMNI_MODEL,
      input: [
        { type: "image", mime_type: "image/png", data: png.data },
        { type: "image", mime_type: "image/jpeg", data: jpeg.data },
        {
          type: "text",
          text: "Use the first supplied image as the starting frame and the second as the ending frame.\nA robot walks in place.",
        },
      ],
      background: true,
      store: true,
      service_tier: "standard",
      generation_config: { max_output_tokens: 27000, video_config: { task: "image_to_video" } },
      response_format: {
        type: "video",
        resolution: "720p",
        aspect_ratio: "16:9",
        duration: "3s",
        delivery: "uri",
      },
    });
    expect(count).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: png.data } },
            { inlineData: { mimeType: "image/jpeg", data: jpeg.data } },
            { text: sent.input[2].text },
          ],
        },
      ],
    });
    expect(String(network.mock.calls[1][0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
    expect(network.mock.calls[1][1]?.redirect).toBe("error");
    expect(network.mock.calls[1][1]?.headers).toMatchObject({ "x-goog-api-key": "fake-key" });
    const textOnly = generationPayload({ ...input, firstFrame: undefined, lastFrame: undefined });
    expect(textOnly.generation_config).toEqual({
      max_output_tokens: 27000,
      video_config: { task: "text_to_video" },
    });
  });

  it("fails closed before all network calls when the startup gate is off", async () => {
    const network = vi.fn<typeof fetch>();
    await expect(submitGeneration(input, "fake-key", { transport: network })).rejects.toThrow(
      "disabled",
    );
    const { service } = await localService(network);
    expect((await service.status()).googleOmniEnabled).toBe(false);
    await expect(service.createJob({ requestId: randomUUID(), generation: input })).rejects.toThrow(
      "disabled",
    );
    expect((await service.status()).budget.committedUsd).toBe(0);
    expect((await service.status()).jobs).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("checks the fixed reservation against the local budget before token preflight", async () => {
    const network = vi.fn<typeof fetch>();
    const { service } = await localService(network, true);
    await service.setBudget({ limitUsd: 1, perJobUsd: 0.49 });
    await expect(service.createJob({ requestId: randomUUID(), generation: input })).rejects.toThrow(
      "local budget",
    );
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).budget.committedUsd).toBe(0);
  });

  it.each([10_001, 0, -1, 1.5, "200", undefined])(
    "rejects invalid count %s before generation or reservation",
    async (totalTokens) => {
      const network = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ totalTokens }));
      const { service } = await localService(network, true);
      await expect(
        service.createJob({ requestId: randomUUID(), generation: input }),
      ).rejects.toThrow("input count");
      expect(network).toHaveBeenCalledTimes(1);
      expect(String(network.mock.calls[0][0])).toContain(":countTokens");
      expect((await service.status()).jobs).toEqual([]);
      expect((await service.status()).budget.committedUsd).toBe(0);
    },
  );

  it("rejects an unavailable or oversized count endpoint and mismatched preflight receipt", async () => {
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("fake-sensitive-error", { status: 404 }));
    await expect(
      submitGeneration(input, "fake-key", { transport: unavailable, enableGoogleOmni: true }),
    ).rejects.toThrow("No generation was submitted");
    expect(unavailable).toHaveBeenCalledTimes(1);
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { headers: { "content-length": "16385" } }));
    await expect(preflightGoogleOmni(input, "fake-key", { transport: oversized })).rejects.toThrow(
      "invalid input-token count",
    );
    const count = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ totalTokens: 999 }));
    const receipt = await preflightGoogleOmni(input, "fake-key", { transport: count });
    const network = vi.fn<typeof fetch>();
    await expect(
      submitGeneration({ ...input, prompt: "Changed" }, "fake-key", {
        transport: network,
        enableGoogleOmni: true,
        omniPreflight: receipt,
      }),
    ).rejects.toThrow("does not match");
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps the reservation after uncertain submission and never resubmits its UUID", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ totalTokens: 500 }))
      .mockRejectedValueOnce(new Error("fake-sensitive-network-error"));
    const { service, stateDir } = await localService(network, true);
    const request = { requestId: randomUUID(), generation: input };
    const job = await service.createJob(request);
    await vi.waitFor(async () => expect((await service.job(job.id)).status).toBe("uncertain"));
    expect((await service.job(job.id)).error).not.toContain("fake-sensitive");
    expect((await service.status()).budget.committedUsd).toBe(0.5);
    expect((await service.createJob(request)).id).toBe(job.id);
    expect(network).toHaveBeenCalledTimes(2);
    expect(await readFile(join(stateDir, "state.json"), "utf8")).not.toContain("fake-omni-key");
  });

  it("treats server errors and malformed identifiers as uncertain without reflecting bodies", async () => {
    for (const response of [
      new Response("fake-sensitive-body", { status: 503 }),
      Response.json({ ...interaction(), id: "../../bad" }),
      Response.json({ status: "in_progress" }),
    ]) {
      const network = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ totalTokens: 2 }))
        .mockResolvedValueOnce(response);
      await expect(
        submitGeneration(input, "fake-key", { transport: network, enableGoogleOmni: true }),
      ).rejects.toMatchObject({ uncertain: true });
      expect(network).toHaveBeenCalledTimes(2);
    }
  });

  it("retains a usable ID from an incomplete submit response for safe retrieval", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ totalTokens: 2 }))
      .mockResolvedValueOnce(Response.json({ id: operation.id }));
    expect(
      await submitGeneration(input, "fake-key", { transport: network, enableGoogleOmni: true }),
    ).toEqual(operation);
  });

  it("handles inline completion and strict file readiness without trusting SDK-only fields", async () => {
    const inline = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(interaction("completed", { data: mp4.toString("base64") })));
    expect(await pollGeneration(operation, "fake-key", { transport: inline })).toEqual({
      status: "done",
      bytes: mp4,
    });
    const files = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(interaction("completed", { uri: fileUrl })))
      .mockResolvedValueOnce(
        Response.json({ name: "files/video-123", mimeType: "video/mp4", state: "PROCESSING" }),
      )
      .mockResolvedValueOnce(Response.json(interaction("completed", { uri: fileUrl })))
      .mockResolvedValueOnce(
        Response.json({ name: "files/video-123", mimeType: "video/mp4", state: "ACTIVE" }),
      );
    expect(await pollGeneration(operation, "fake-key", { transport: files })).toEqual({
      status: "pending",
    });
    expect(await pollGeneration(operation, "fake-key", { transport: files })).toEqual({
      status: "done",
      url: fileUrl,
      downloadKind: "omni",
    });
    expect(String(files.mock.calls[1][0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/files/video-123",
    );
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...interaction("completed"),
        output_video: { data: mp4.toString("base64") },
      }),
    );
    await expect(pollGeneration(operation, "fake-key", { transport: wrong })).rejects.toThrow(
      "invalid interaction",
    );
  });

  it.each(["failed", "cancelled", "incomplete", "requires_action"])(
    "stops terminal interaction %s without continuation or tools",
    async (status) => {
      const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(interaction(status)));
      expect(await pollGeneration(operation, "fake-key", { transport: network })).toEqual({
        status: "failed",
      });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects bad MIME/base64, mismatched IDs and excessive JSON before media allocation", async () => {
    for (const video of [
      { data: mp4.toString("base64"), mime_type: "image/png" },
      { data: "%invalid" },
      { data: "YWJjZA==" },
      {},
    ]) {
      const network = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(interaction("completed", video)));
      await expect(pollGeneration(operation, "fake-key", { transport: network })).rejects.toThrow();
    }
    const wrongId = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...interaction(), id: "v1_other" }));
    await expect(pollGeneration(operation, "fake-key", { transport: wrongId })).rejects.toThrow(
      "unexpected",
    );
    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { headers: { "content-length": "1073741824" } }));
    await expect(pollGeneration(operation, "fake-key", { transport: oversized })).rejects.toThrow(
      "invalid response",
    );
  });

  it("keeps authenticated downloads on the documented host/path and rejects redirects", async () => {
    expect(validateOmniDownloadUrl(fileUrl).toString()).toBe(fileUrl);
    for (const address of [
      fileUrl.replace("generativelanguage.googleapis.com", "storage.googleapis.com"),
      fileUrl.replace("https:", "http:"),
      fileUrl.replace("/files/video-123:download", "/models/gemini:generateContent"),
      `${fileUrl}&key=secret`,
      `${fileUrl}#fragment`,
      fileUrl.replace("video-123", "%2fsecret"),
    ])
      expect(() => validateOmniDownloadUrl(address)).toThrow();
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(mp4, { headers: { "content-type": "video/mp4" } }));
    expect(await downloadOmniVideo(fileUrl, "fake-key", { transport: network })).toEqual(mp4);
    expect(network.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { "x-goog-api-key": "fake-key" },
    });
    const redirected = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://outside.invalid/video.mp4" },
      }),
    );
    await expect(
      downloadOmniVideo(fileUrl, "fake-key", { transport: redirected }),
    ).rejects.toThrow();
    expect(redirected).toHaveBeenCalledTimes(1);
  });

  it("retains interaction identity durably and resumes while the paid flag is off", async () => {
    const network = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith(":countTokens")) return Response.json({ totalTokens: 500 });
      return Response.json(interaction());
    });
    const { service, stateDir } = await localService(network, true);
    const job = await service.createJob({ requestId: randomUUID(), generation: input });
    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
      expect(state.jobs[0].operation).toEqual(operation);
    });
    await service.close();
    const resumed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(interaction("completed", { data: mp4.toString("base64") })));
    const { service: restarted } = await localService(resumed, false, stateDir);
    await vi.waitFor(async () => expect((await restarted.job(job.id)).status).toBe("done"));
    expect(resumed.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    expect((await restarted.status()).budget.committedUsd).toBe(0.5);
    expect(await readFile(await restarted.artifactPath(job.id, "video.mp4"))).toEqual(mp4);
    const persisted = await readFile(join(stateDir, "state.json"), "utf8");
    expect(persisted).not.toContain(mp4.toString("base64"));
    expect(persisted).not.toContain("fake-omni-key");
  });
});
