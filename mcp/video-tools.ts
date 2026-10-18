import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  VIDEO_MODELS,
  VIDEO_PROVIDERS,
  VIDEO_PRICING_DATE,
  MAX_VIDEO_BYTES,
  processingOptionsSchema,
  validateGeneration,
  type GenerationInput,
  type PublicJob,
} from "../src/lib/video/schema";

interface Connection {
  origin: string;
  token: string;
}
async function connection(): Promise<Connection> {
  const root =
    process.env.SPRITE_TOOLS_VIDEO_HOME ?? join(homedir(), ".config", "sprite-tools", "video");
  try {
    const path = join(root, "connection.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && info.mode & 0o077))
      throw new Error("private");
    const value = JSON.parse(await readFile(path, "utf8")) as Connection;
    if (
      !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin) ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(value.token)
    )
      throw new Error("invalid");
    return value;
  } catch {
    throw new Error("Start sprite-tools studio and unlock its local setup page first.");
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const { origin, token } = await connection();
  let response: Response;
  try {
    response = await fetch(`${origin}/api/studio${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Local Video Studio is unreachable. Start sprite-tools studio.");
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string" ? result.error : "Video Studio request failed.",
    );
  return result as T;
}

async function imageInput(path: string): Promise<NonNullable<GenerationInput["firstFrame"]>> {
  if (!isAbsolute(path)) throw new Error("Image references must be absolute local file paths.");
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > 8 * 1024 * 1024)
    throw new Error("Reference images must be PNG or JPEG files of at most 8 MB.");
  const bytes = await readFile(path);
  const png = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  if (!png && !jpeg) throw new Error("Reference images must be PNG or JPEG files.");
  return { mimeType: png ? "image/png" : "image/jpeg", data: bytes.toString("base64") };
}

async function waitJob(job: PublicJob, seconds: number): Promise<PublicJob> {
  const deadline = Date.now() + seconds * 1000;
  let current = job;
  while (["queued", "generating", "processing"].includes(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    current = await call<PublicJob>(`/jobs/${encodeURIComponent(current.id)}`);
  }
  return current;
}
const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
async function safe(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Video Studio request failed.",
        },
      ],
    };
  }
}
const waitSchema = z
  .number()
  .int()
  .min(0)
  .max(30)
  .default(0)
  .describe(
    "Wait up to this many seconds, then return the resumable job. Default 0; maximum 30. Poll sprite_video_status afterwards.",
  );
const requestSchema = z
  .string()
  .uuid()
  .describe("Stable UUID for this request. Reuse on retries to avoid another paid generation.");

export function registerVideoTools(server: McpServer) {
  server.registerTool(
    "sprite_video_capabilities",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "List supported Google/xAI video models, controls, price estimates and local Studio budget/status. Configure provider keys only in the local setup page; never pass keys through MCP.",
      inputSchema: {},
    },
    () =>
      safe(async () => ({
        models: VIDEO_MODELS,
        providers: VIDEO_PROVIDERS,
        pricingDate: VIDEO_PRICING_DATE,
        status: await call("/status"),
      })),
  );

  server.registerTool(
    "sprite_video_generate",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Upload the prompt and reference images to your selected Google or xAI provider and generate a paid video using the local budget cap. Automatically produce a transparent sprite sheet, collision bounds/polygons, pivots and timing. Returns a resumable job and absolute output paths once done. Reuse request_id on retries; paid dispatch is never automatically repeated.",
      inputSchema: {
        request_id: requestSchema,
        provider: z
          .enum(["google", "xai"])
          .describe("Provider configured in the local Studio setup page."),
        model: z.string().describe("Model ID from sprite_video_capabilities."),
        prompt: z
          .string()
          .min(1)
          .max(8000)
          .describe(
            "Motion/character prompt. For sprites use a fixed camera, centered subject, flat green background, no shadows and no camera movement.",
          ),
        duration_seconds: z
          .number()
          .int()
          .min(1)
          .max(15)
          .describe("Video length in seconds; must match model capabilities."),
        resolution: z
          .enum(["480p", "720p", "1080p"])
          .describe(
            "Provider output resolution; supported values depend on the model and references.",
          ),
        aspect_ratio: z
          .string()
          .describe("Aspect ratio supported by the model, such as 16:9 or 1:1."),
        first_frame_path: z
          .string()
          .optional()
          .describe("Absolute local PNG/JPEG path for the starting frame, maximum 8 MB."),
        last_frame_path: z
          .string()
          .optional()
          .describe("Absolute local PNG/JPEG path for the ending frame, only on supported models."),
        reference_image_paths: z
          .array(z.string())
          .max(14)
          .optional()
          .describe(
            "Absolute local PNG/JPEG reference paths. Model-specific count and combination limits apply.",
          ),
        processing: processingOptionsSchema
          .partial()
          .optional()
          .describe(
            "Sprite extraction: fps, frameWidth, backgroundColor, tolerance, softness, spill, choke, columns, padding, name. Trim with startSeconds/endSeconds; loopMode 'auto' suggests a cycle within loopMinSeconds/loopMaxSeconds. maxFrames caps exported frames; dedupeThreshold 0–8 merges adjacent duplicates while preserving hold time. At most 120 sampled input frames; review suggested loops.",
          ),
        wait_seconds: waitSchema,
      },
    },
    (input) =>
      safe(async () => {
        const generation = validateGeneration({
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          durationSeconds: input.duration_seconds,
          resolution: input.resolution,
          aspectRatio: input.aspect_ratio,
          firstFrame: input.first_frame_path ? await imageInput(input.first_frame_path) : undefined,
          lastFrame: input.last_frame_path ? await imageInput(input.last_frame_path) : undefined,
          referenceImages: input.reference_image_paths
            ? await Promise.all(input.reference_image_paths.map(imageInput))
            : undefined,
        });
        return waitJob(
          await call<PublicJob>("/jobs", {
            requestId: input.request_id,
            generation,
            processing: input.processing,
          }),
          input.wait_seconds,
        );
      }),
  );

  server.registerTool(
    "sprite_video_status",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Resume a Video Studio job without starting a new generation. Returns status, safe errors, reserved cost and absolute video/sheet/metadata paths when ready.",
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe("Job UUID returned by sprite_video_generate or sprite_video_import."),
        wait_seconds: waitSchema,
      },
    },
    ({ job_id, wait_seconds }) =>
      safe(async () => waitJob(await call<PublicJob>(`/jobs/${job_id}`), wait_seconds)),
  );

  server.registerTool(
    "sprite_video_import",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      description:
        "Turn an existing local MP4 into a transparent sprite sheet plus collision/pivot/timing metadata. No provider request or cost. Requires ffmpeg and ffprobe installed for the local companion.",
      inputSchema: {
        input_path: z
          .string()
          .describe(
            `Absolute local path to an MP4, at most ${MAX_VIDEO_BYTES / 1024 / 1024} MiB and 30 seconds.`,
          ),
        request_id: requestSchema,
        processing: processingOptionsSchema
          .partial()
          .optional()
          .describe(
            "Defaults: 8 fps, 128 px frame width, green key, 8 columns. startSeconds/endSeconds trim the source; loopMode 'auto' suggests a loop within loopMinSeconds/loopMaxSeconds; maxFrames caps output; optional dedupeThreshold 0–8 merges adjacent duplicates and keeps their hold time. Maximum 120 sampled input frames.",
          ),
        wait_seconds: waitSchema,
      },
    },
    ({ input_path, request_id, processing, wait_seconds }) =>
      safe(async () => {
        if (!isAbsolute(input_path)) throw new Error("Video must be an absolute local file path.");
        const info = await stat(input_path);
        if (!info.isFile() || info.size === 0 || info.size > MAX_VIDEO_BYTES)
          throw new Error(`Video must be a file of at most ${MAX_VIDEO_BYTES / 1024 / 1024} MiB.`);
        const bytes = await readFile(input_path);
        if (!/\.mp4$/i.test(input_path) || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
          throw new Error("Choose an MP4 video file. Convert WebM files to MP4 before importing.");
        }
        const videoBase64 = bytes.toString("base64");
        return waitJob(
          await call<PublicJob>("/import", {
            requestId: request_id,
            fileName: basename(input_path),
            videoBase64,
            processing,
          }),
          wait_seconds,
        );
      }),
  );

  server.registerTool(
    "sprite_video_reprocess",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      description:
        "Retry sprite extraction from an already downloaded job video, using new processing settings. Never starts or charges for another provider generation.",
      inputSchema: {
        job_id: z.string().uuid().describe("Existing job UUID with a downloaded video."),
        processing: processingOptionsSchema
          .partial()
          .describe(
            "Replacement extraction settings. Use startSeconds/endSeconds for trimming, loopMode 'auto' plus loopMinSeconds/loopMaxSeconds for a suggested cycle, maxFrames for an output budget, and dedupeThreshold 0–8 for adjacent duplicates. Timing is preserved; review the exported loop and sourceFrameIndices.",
          ),
        wait_seconds: waitSchema,
      },
    },
    ({ job_id, processing, wait_seconds }) =>
      safe(async () =>
        waitJob(
          await call<PublicJob>(`/jobs/${job_id}/retry-processing`, { processing }),
          wait_seconds,
        ),
      ),
  );
}
