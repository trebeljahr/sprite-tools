import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVideoTools } from "../mcp/video-tools";

type Result = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (input: Record<string, unknown>) => Promise<Result>;
let root: string;
let handlers: Map<string, Handler>;
const fetchMock = vi.fn();
const token = "test-local-companion-token-000000000000000";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sprite-video-mcp-"));
  await writeFile(
    join(root, "connection.json"),
    JSON.stringify({ origin: "http://127.0.0.1:55555", token }),
    { mode: 0o600 },
  );
  vi.stubEnv("SPRITE_TOOLS_VIDEO_HOME", root);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  handlers = new Map();
  const server = {
    registerTool: (name: string, _options: unknown, handler: Handler) =>
      handlers.set(name, handler),
  };
  registerVideoTools(server as unknown as McpServer);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("video MCP transport", () => {
  it("passes a stable request ID and safe generation to the companion without exposing its token", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id, status: "generating", reservedUsd: 0.4 })),
    );
    const result = await handlers.get("sprite_video_generate")!({
      request_id: id,
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "Fox idle on flat green",
      duration_seconds: 4,
      resolution: "720p",
      aspect_ratio: "16:9",
      wait_seconds: 0,
    });
    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:55555/api/studio/jobs");
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body).requestId).toBe(id);
    expect(result.content[0].text).not.toContain(token);
    expect(result.content[0].text).not.toContain("Authorization");
  });

  it("returns artifact paths from polling and never starts a generation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const job = {
      id,
      status: "done",
      reservedUsd: 0,
      artifacts: {
        videoPath: "/private/job/video.mp4",
        sheetPath: "/private/job/sheet.png",
        metadataPath: "/private/job/metadata.json",
      },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(job)));
    const result = await handlers.get("sprite_video_status")!({ job_id: id, wait_seconds: 0 });
    expect(JSON.parse(result.content[0].text)).toEqual(job);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("rejects remote connection files before sending the bearer", async () => {
    await writeFile(
      join(root, "connection.json"),
      JSON.stringify({ origin: "https://example.com", token }),
    );
    const result = await handlers.get("sprite_video_capabilities")!({});
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain(token);
  });

  it("rejects non-image references before network access", async () => {
    const path = join(root, "bad.png");
    await writeFile(path, "not an image");
    const result = await handlers.get("sprite_video_generate")!({
      request_id: "11111111-1111-4111-8111-111111111111",
      provider: "google",
      model: "veo-3.1-fast-generate-preview",
      prompt: "Fox",
      duration_seconds: 4,
      resolution: "720p",
      aspect_ratio: "16:9",
      first_frame_path: path,
      wait_seconds: 0,
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reprocesses the saved job without a paid request", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id, status: "processing", reservedUsd: 0.4 })),
    );
    await handlers.get("sprite_video_reprocess")!({
      job_id: id,
      processing: { fps: 4 },
      wait_seconds: 0,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:55555/api/studio/jobs/${id}/retry-processing`,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ processing: { fps: 4 } });
  });
});
