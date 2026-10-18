import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVideoService,
  type VideoService,
  type VideoServiceOptions,
} from "../src/lib/video/service";
import type { GenerationInput } from "../src/lib/video/schema";
const generation: GenerationInput = {
  provider: "google",
  model: "veo-3.1-fast-generate-preview",
  prompt: "A blue robot walks in place against flat green.",
  durationSeconds: 4,
  resolution: "720p",
  aspectRatio: "16:9",
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
const passphrase = "test-only-vault-passphrase";
const directories: string[] = [];
const services: VideoService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const processor: NonNullable<VideoServiceOptions["processVideo"]> = async ({
  videoPath,
  outputDir,
}) => {
  const sheetPath = join(outputDir, "sheet.png");
  const metadataPath = join(outputDir, "metadata.json");
  await writeFile(sheetPath, "fake-png", { mode: 0o600 });
  await writeFile(metadataPath, "{}", { mode: 0o600 });
  return { videoPath, sheetPath, metadataPath };
};
function transport() {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === "POST") return Response.json({ name: "operations/test-operation" });
    if (String(url).includes("operations/"))
      return Response.json({
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
      });
    return new Response(mp4, { headers: { "content-type": "video/mp4" } });
  });
}
async function fixture(options: VideoServiceOptions = {}) {
  const dir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "sprite-video-service-")));
  if (!directories.includes(dir)) directories.push(dir);
  const service = await createVideoService({
    stateDir: dir,
    transport: transport(),
    processVideo: processor,
    pollIntervalMs: 5,
    maxPollMs: 500,
    ...options,
  });
  services.push(service);
  return { service, dir };
}
async function configure(service: VideoService, limitUsd = 10, perJobUsd = 1) {
  await service.unlock(passphrase);
  await service.setCredential("google", "fake-google-api-key");
  await service.setBudget({ limitUsd, perJobUsd });
}
async function done(service: VideoService, id: string) {
  await vi.waitFor(async () => expect((await service.job(id)).status).toBe("done"), {
    timeout: 2000,
    interval: 10,
  });
}

describe("durable local video service", () => {
  it("defaults to zero spend and reserves once across concurrent duplicate requests", async () => {
    const network = transport();
    const { service, dir } = await fixture({ transport: network });
    expect((await service.status()).simulation).toBe(false);
    expect((await service.status()).budget).toEqual({
      limitUsd: 0,
      perJobUsd: 0,
      committedUsd: 0,
      remainingUsd: 0,
    });
    await service.unlock(passphrase);
    await service.setCredential("google", "fake-google-api-key");
    await expect(service.createJob({ requestId: randomUUID(), generation })).rejects.toThrow(
      "local budget",
    );
    expect(network).not.toHaveBeenCalled();
    await service.setBudget({ limitUsd: 1, perJobUsd: 0.5 });
    const input = { requestId: randomUUID(), generation };
    const [a, b] = await Promise.all([service.createJob(input), service.createJob(input)]);
    expect(a.id).toBe(b.id);
    await done(service, a.id);
    expect(network.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    expect((await service.status()).budget.committedUsd).toBe(0.4);
    expect(await readFile(join(dir, "state.json"), "utf8")).not.toContain("fake-google-api-key");
    await expect(
      service.createJob({
        ...input,
        generation: { ...generation, prompt: "Different same-price input" },
      }),
    ).rejects.toThrow("different settings");
    await expect(service.setBudget({ limitUsd: 0.3, perJobUsd: 0.3 })).rejects.toThrow(
      "lower than committed",
    );
    await expect(service.artifactPath(a.id, "../../vault.json")).rejects.toThrow(
      "Artifact not found",
    );
  });
  it("checks processor frame limits and per-request limits before dispatch", async () => {
    const network = transport();
    const { service } = await fixture({ transport: network });
    await configure(service, 10, 0.3);
    await expect(service.createJob({ requestId: randomUUID(), generation })).rejects.toThrow(
      "local budget",
    );
    await expect(
      service.createJob({
        requestId: randomUUID(),
        generation: { ...generation, durationSeconds: 8 },
        processing: { fps: 24 },
      }),
    ).rejects.toThrow("120 frames");
    await expect(
      service.createJob({
        requestId: randomUUID(),
        generation,
        processing: { startSeconds: 1, endSeconds: 5 },
      }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).budget.committedUsd).toBe(0);
    await service.setBudget({ limitUsd: 10, perJobUsd: 1 });
    const trimmed = await service.createJob({
      requestId: randomUUID(),
      generation: { ...generation, durationSeconds: 8 },
      processing: { fps: 24, startSeconds: 2, endSeconds: 4, maxFrames: 12 },
    });
    await done(service, trimmed.id);
    expect(network.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });
  it("keeps uncertain submission reservations and requires deliberate resolution", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("fake-secret-provider-error"));
    const { service } = await fixture({ transport: network });
    await configure(service);
    const job = await service.createJob({ requestId: randomUUID(), generation });
    await vi.waitFor(async () => expect((await service.job(job.id)).status).toBe("uncertain"));
    expect((await service.job(job.id)).error).not.toContain("fake-secret");
    await expect(service.createJob({ requestId: randomUUID(), generation })).rejects.toThrow(
      "uncertain",
    );
    await service.resolveUncertain(job.id);
    expect((await service.job(job.id)).status).toBe("failed");
    expect((await service.status()).budget.committedUsd).toBe(0.4);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("resumes a known provider operation after restart and unlock without another POST", async () => {
    const firstTransport = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "POST"
        ? Response.json({ name: "operations/saved-operation" })
        : Response.json({ done: false }),
    );
    const { service, dir } = await fixture({
      transport: firstTransport,
      pollIntervalMs: 10_000,
      maxPollMs: 60_000,
    });
    await configure(service);
    const job = await service.createJob({ requestId: randomUUID(), generation });
    await vi.waitFor(async () =>
      expect(await readFile(join(dir, "state.json"), "utf8")).toContain("saved-operation"),
    );
    await service.close();
    const nextTransport = transport();
    const { service: restarted } = await fixture({ stateDir: dir, transport: nextTransport });
    expect((await restarted.status()).locked).toBe(true);
    expect(nextTransport).not.toHaveBeenCalled();
    await restarted.unlock(passphrase);
    await done(restarted, job.id);
    expect(nextTransport.mock.calls.some(([, request]) => request?.method === "POST")).toBe(false);
    expect((await restarted.status()).budget.committedUsd).toBe(0.4);
  });
  it("retries processing from the saved video without new paid dispatch", async () => {
    const network = transport();
    const process = vi
      .fn<NonNullable<VideoServiceOptions["processVideo"]>>()
      .mockRejectedValueOnce(new Error("fake-sensitive-decoder-error"))
      .mockImplementation(processor);
    const { service } = await fixture({ transport: network, processVideo: process });
    await configure(service);
    const job = await service.createJob({ requestId: randomUUID(), generation });
    await vi.waitFor(async () => expect((await service.job(job.id)).status).toBe("failed"));
    expect((await service.job(job.id)).error).not.toContain("sensitive");
    expect((await service.job(job.id)).outputRevision).toBe(0);
    await service.retryProcessing(job.id);
    await done(service, job.id);
    expect((await service.job(job.id)).outputRevision).toBe(1);
    expect(network.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    expect(process).toHaveBeenCalledTimes(2);
  });
  it("persists output revisions across reprocessing and safely loads older jobs", async () => {
    const network = transport();
    const { service, dir } = await fixture({ transport: network });
    const job = await service.importVideo({
      requestId: randomUUID(),
      fileName: "test.mp4",
      videoBase64: mp4.toString("base64"),
      processing: { fps: 24, frameWidth: 512, backgroundColor: "#abd3de", maxFrames: 12 },
    });
    await done(service, job.id);
    expect((await service.job(job.id)).outputRevision).toBe(1);
    expect(job.processing).toMatchObject({
      fps: 24,
      frameWidth: 512,
      backgroundColor: "#abd3de",
      maxFrames: 12,
    });
    job.processing.backgroundColor = "#00ff00";
    expect((await service.job(job.id)).processing.backgroundColor).toBe("#abd3de");
    await service.retryProcessing(job.id, { maxFrames: 12 });
    await done(service, job.id);
    expect((await service.status()).jobs[0].outputRevision).toBe(2);
    await service.close();
    const { service: restarted } = await fixture({ stateDir: dir, transport: network });
    expect((await restarted.job(job.id)).outputRevision).toBe(2);
    await restarted.close();
    const statePath = join(dir, "state.json");
    const oldState = JSON.parse(await readFile(statePath, "utf8")) as {
      jobs: Array<{ outputRevision?: number }>;
    };
    delete oldState.jobs[0].outputRevision;
    await writeFile(statePath, JSON.stringify(oldState), { mode: 0o600 });
    const { service: legacy } = await fixture({ stateDir: dir, transport: network });
    expect((await legacy.job(job.id)).outputRevision).toBe(0);
    expect((await legacy.job(job.id)).processing.loopMode).toBe("full");
    await legacy.retryProcessing(job.id);
    await done(legacy, job.id);
    expect((await legacy.job(job.id)).outputRevision).toBe(1);
    expect(network).not.toHaveBeenCalled();
  });
  it("uses an exclusive state lock and rejects queued dispatch during shutdown", async () => {
    const network = transport();
    const { service, dir } = await fixture({ transport: network });
    await expect(createVideoService({ stateDir: dir })).rejects.toThrow("storage is locked");
    await configure(service);
    const pending = service.createJob({ requestId: randomUUID(), generation });
    const stopping = service.close();
    await expect(pending).rejects.toThrow("stopping");
    await stopping;
    expect(network).not.toHaveBeenCalled();
    const { service: restarted } = await fixture({ stateDir: dir });
    expect((await restarted.status()).jobs).toEqual([]);
  });
  it("rejects WebM and falsely labeled video bytes before creating an import job", async () => {
    const network = transport();
    const { service } = await fixture({ transport: network });
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
    await expect(
      service.importVideo({ requestId: randomUUID(), fileName: "test.webm", videoBase64: webm }),
    ).rejects.toThrow("MP4 video");
    await expect(
      service.importVideo({ requestId: randomUUID(), fileName: "test.mp4", videoBase64: webm }),
    ).rejects.toThrow("valid MP4");
    expect((await service.status()).jobs).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
  it("imports a local video while locked without any provider call", async () => {
    const network = transport();
    const { service } = await fixture({ transport: network, simulation: true });
    expect((await service.status()).simulation).toBe(true);
    const job = await service.importVideo({
      requestId: randomUUID(),
      fileName: "test.mp4",
      videoBase64: mp4.toString("base64"),
    });
    await done(service, job.id);
    expect(job.reservedUsd).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });
});
