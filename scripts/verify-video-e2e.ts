/** Offline integration: real HTTP + MCP stdio + FFmpeg, fake provider HTTP only.
 * Build CLI/MCP first. Run: node --import tsx scripts/verify-video-e2e.ts
 * --preview keeps the fake-provider studio open for browser QA until SIGINT.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { startStudio } from "../src/lib/video/http";
import type { PublicJob, StudioStatus } from "../src/lib/video/schema";
import { normalizeExportInput } from "../src/lib/export/types";

async function main() {
  const option = (name: string) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const referencePath = option("--reference-image");
  const importPath = option("--import-video");
  const root = await mkdtemp(join(tmpdir(), "sprite-video-e2e-"));
  const frames = join(root, "frames");
  await mkdir(frames);
  for (let frame = 0; frame < 16; frame++) {
    const png = new PNG({ width: 96, height: 96 });
    const rect = (x: number, y: number, width: number, height: number, color: number[]) => {
      for (let yy = y; yy < y + height; yy++)
        for (let xx = x; xx < x + width; xx++) png.data.set([...color, 255], (yy * 96 + xx) * 4);
    };
    rect(0, 0, 96, 96, [0, 255, 0]);
    const bob = Math.round(Math.sin((frame * Math.PI) / 4) * 2);
    rect(35, 20 + bob, 26, 20, [215, 50, 57]);
    rect(38, 40 + bob, 20, 26, [173, 27, 38]);
    rect(29, 44 + bob + (frame % 4), 9, 22, [215, 50, 57]);
    rect(58, 44 + bob + 3 - (frame % 4), 9, 22, [215, 50, 57]);
    rect(38, 66 + bob, 8, 17 + (frame % 4), [62, 70, 85]);
    rect(50, 66 + bob, 8, 20 - (frame % 4), [62, 70, 85]);
    rect(40, 26 + bob, 5, 5, [30, 40, 55]);
    rect(52, 26 + bob, 5, 5, [30, 40, 55]);
    rect(44, 34 + bob, 8, 2, [255, 212, 122]);
    await writeFile(
      join(frames, `frame-${String(frame).padStart(4, "0")}.png`),
      PNG.sync.write(png),
    );
  }
  const fixture = join(root, "robot-fixture.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-framerate",
      "8",
      "-i",
      join(frames, "frame-%04d.png"),
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      fixture,
    ],
    { timeout: 30_000 },
  );
  const media = await readFile(fixture);
  const counts = { google: 0, xai: 0 };
  const fakeTransport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(":predictLongRunning")) {
      counts.google++;
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "fake-google-offline-key");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.instances.length, 1);
      assert.ok(payload.instances[0].prompt);
      return Response.json({
        name: "models/veo-3.1-fast-generate-preview/operations/offline-google",
      });
    }
    if (url === "https://api.x.ai/v1/videos/generations") {
      counts.xai++;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-xai-offline-key");
      const payload = JSON.parse(String(init?.body));
      assert.match(payload.image.url, /^data:image\/(png|jpeg);base64,/);
      assert.match(payload.last_frame.url, /^data:image\/(png|jpeg);base64,/);
      return Response.json({ request_id: "offline-xai" });
    }
    if (url.endsWith("operations/offline-google"))
      return Response.json({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  uri: "https://generativelanguage.googleapis.com/v1beta/files/offline:download?alt=media",
                },
              },
            ],
          },
        },
      });
    if (url === "https://api.x.ai/v1/videos/offline-xai")
      return Response.json({ status: "done", video: { url: "https://vidgen.x.ai/offline.mp4" } });
    if (url.includes("/files/offline:download") || url === "https://vidgen.x.ai/offline.mp4")
      return new Response(media, { headers: { "Content-Type": "video/mp4" } });
    throw new Error("Unexpected offline provider request");
  };
  const stateDir = join(root, "state");
  const studio = await startStudio({
    simulation: true,
    stateDir,
    webRoot: resolve("out"),
    transport: fakeTransport,
    pollIntervalMs: 10,
    maxPollMs: 10_000,
  });
  const headers = { Authorization: `Bearer ${studio.token}`, "Content-Type": "application/json" };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${studio.origin}/api/studio/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `Local API failed: ${path} ${response.status}`);
    return response.json() as Promise<T>;
  }
  const client = new Client({ name: "sprite-tools-offline-verifier", version: "1.0.0" });
  let connected = false;
  try {
    await api("unlock", { passphrase: "offline-fixture-passphrase" });
    await api("credentials", { provider: "google", apiKey: "fake-google-offline-key" });
    await api("credentials", { provider: "xai", apiKey: "fake-xai-offline-key" });
    await api("budget", { limitUsd: 1, perJobUsd: 0.5 });
    const request = {
      requestId: randomUUID(),
      generation: {
        provider: "google",
        model: "veo-3.1-fast-generate-preview",
        prompt: "Red robot walks in place on flat green, fixed side camera.",
        durationSeconds: 4,
        resolution: "720p",
        aspectRatio: "16:9",
      },
      processing: { fps: 8, tolerance: 160, frameWidth: 128, name: "robot" },
    };
    const google = await api<PublicJob>("jobs", request);
    assert.equal((await api<PublicJob>("jobs", request)).id, google.id);
    async function completed(id: string) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const job = await api<PublicJob>(`jobs/${id}`);
        if (job.status === "done") return job;
        assert.notEqual(job.status, "failed", job.error);
        assert.notEqual(job.status, "uncertain", job.error);
        await new Promise((done) => setTimeout(done, 100));
      }
      throw new Error("Offline processing timed out");
    }
    const googleResult = await completed(google.id);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/mcp/index.js")],
        env: { ...env, SPRITE_TOOLS_VIDEO_HOME: stateDir },
        stderr: "pipe",
      }),
    );
    connected = true;
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "sprite_video_generate"));
    const mcpRequest = {
      request_id: randomUUID(),
      provider: "xai",
      model: "grok-imagine-video-1.5",
      prompt: "Red robot walks in place on flat green, fixed side camera.",
      duration_seconds: 2,
      resolution: "480p",
      aspect_ratio: "1:1",
      first_frame_path: referencePath ?? join(frames, "frame-0000.png"),
      last_frame_path: referencePath ?? join(frames, "frame-0015.png"),
      processing: { fps: 8, tolerance: 160, frameWidth: 128, name: "robot" },
      wait_seconds: 10,
    };
    const result = await client.callTool({ name: "sprite_video_generate", arguments: mcpRequest });
    assert.equal(result.isError, undefined, "MCP generation returned an error");
    const content = result.content as Array<{ type: string; text?: string }>;
    const xaiResult = JSON.parse(content.find((item) => item.type === "text")!.text!) as PublicJob;
    assert.equal(xaiResult.status, "done");
    const duplicate = await client.callTool({
      name: "sprite_video_generate",
      arguments: mcpRequest,
    });
    assert.equal(duplicate.isError, undefined);
    assert.deepEqual(counts, { google: 1, xai: 1 });
    for (const job of [googleResult, xaiResult]) {
      assert.ok(job.artifacts);
      const metadata = JSON.parse(await readFile(job.artifacts.metadataPath, "utf8"));
      const sheet = PNG.sync.read(await readFile(job.artifacts.sheetPath));
      const downloaded = await fetch(`${studio.origin}/api/studio/jobs/${job.id}/files/sheet.png`, {
        headers,
      });
      assert.ok(downloaded.ok);
      assert.deepEqual(
        Buffer.from(await downloaded.arrayBuffer()),
        await readFile(job.artifacts.sheetPath),
      );
      assert.equal(
        (await fetch(`${studio.origin}/api/studio/jobs/${job.id}/files/sheet.png`)).status,
        401,
      );
      assert.equal(metadata.frameCount, 16);
      assert.equal(metadata.hitboxes.length, 16);
      assert.ok(
        metadata.collision.every((frame: { polygon: unknown[] }) => frame.polygon.length >= 3),
      );
      assert.equal(normalizeExportInput(metadata).frames.length, 16);
      assert.ok(sheet.data.some((alpha, index) => index % 4 === 3 && alpha === 0));
      assert.ok(sheet.data.some((alpha, index) => index % 4 === 3 && alpha === 255));
    }
    const before = await api<StudioStatus>("status");
    const reprocessed = await client.callTool({
      name: "sprite_video_reprocess",
      arguments: {
        job_id: xaiResult.id,
        processing: { fps: 4, tolerance: 160, frameWidth: 96 },
        wait_seconds: 10,
      },
    });
    assert.ok(!reprocessed.isError, "MCP reprocessing returned an error");
    const reprocessedMetadata = JSON.parse(
      await readFile(xaiResult.artifacts!.metadataPath, "utf8"),
    );
    assert.equal(reprocessedMetadata.frameCount, 8);
    assert.deepEqual(counts, { google: 1, xai: 1 });
    assert.equal(
      (await api<StudioStatus>("status")).budget.committedUsd,
      before.budget.committedUsd,
    );
    const vault = await readFile(join(stateDir, "vault.json"), "utf8");
    assert.ok(
      !vault.includes("fake-google") &&
        !vault.includes("fake-xai") &&
        !vault.includes("offline-fixture-passphrase"),
    );
    let imported: PublicJob | undefined;
    if (importPath) {
      const result = await client.callTool({
        name: "sprite_video_import",
        arguments: {
          input_path: resolve(importPath),
          request_id: randomUUID(),
          processing: {
            name: "production-loop-study",
            fps: 24,
            frameWidth: 512,
            backgroundColor: option("--background-color") ?? "#00ff00",
            tolerance: 50,
            softness: 20,
            spill: 15,
            choke: 0,
            loopMode: "auto",
            loopMinSeconds: 0.5,
            loopMaxSeconds: 2,
            maxFrames: 12,
          },
          wait_seconds: 30,
        },
      });
      assert.ok(
        !result.isError,
        `MCP production-video import failed: ${JSON.stringify(result.content)}`,
      );
      const content = result.content as Array<{ type: string; text?: string }>;
      imported = JSON.parse(content.find((item) => item.type === "text")!.text!) as PublicJob;
      assert.equal(imported.status, "done");
      const metadata = JSON.parse(await readFile(imported.artifacts!.metadataPath, "utf8"));
      assert.ok(metadata.frameCount >= 2 && metadata.frameCount <= 12);
      assert.equal(metadata.hitboxes.length, metadata.frameCount);
      assert.equal(normalizeExportInput(metadata).frames.length, metadata.frameCount);
      assert.deepEqual(counts, { google: 1, xai: 1 });
      assert.equal(
        (await api<StudioStatus>("status")).budget.committedUsd,
        before.budget.committedUsd,
      );
    }
    await writeFile(
      join(root, "receipt.json"),
      JSON.stringify(
        {
          mode: "offline provider simulation; real FFmpeg, HTTP and MCP stdio",
          providerSubmissions: counts,
          committedEstimateUsd: before.budget.committedUsd,
          actualProviderSpendUsd: 0,
          referencePath,
          importPath,
          imported,
          google: googleResult,
          xai: xaiResult,
        },
        null,
        2,
      ),
    );
    // Private pairing file for browser QA. Its contents are never printed.
    await writeFile(join(root, "setup-url.txt"), `${studio.origin}/setup#token=${studio.token}`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        ok: true,
        evidenceDir: root,
        origin: studio.origin,
        providerSubmissions: counts,
        actualSpendUsd: 0,
      }),
    );
    if (process.argv.includes("--preview")) {
      console.log(
        "Offline studio ready for browser QA. Only fake provider responses are enabled. Stop with Ctrl-C.",
      );
      await new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
    }
  } finally {
    if (connected) await client.close();
    await studio.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Offline E2E failed");
  process.exitCode = 1;
});
