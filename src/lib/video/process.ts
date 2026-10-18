import "../../../cli/lib/imagedata-shim";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadPng, savePng, stitchSheet } from "../../../cli/lib/image-io";
import { applyChromaKeyToImageData, hexToRgb } from "../pipeline/chroma-core";
import { computeTrimRect } from "../atlas/pack";
import { generateOutline } from "../collision/outline";
import { MAX_VIDEO_BYTES, type ProcessingOptions } from "./schema";
import {
  VideoProcessingError,
  resolveVideoTrim,
  selectVideoFrames,
  validateVideoProcessing,
  type VideoInterval,
} from "./loop";

export type { ProcessingOptions } from "./schema";
export { VideoProcessingError } from "./loop";
const MAX_FRAMES = 120;
const MAX_SHEET_PIXELS = 16_777_216;

/** Never invokes a shell. Restrict formats/protocols at both probe and decode. */
async function runMedia(binary: string, args: string[], maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    const stop = (message: string) => {
      if (failure) return;
      failure = new VideoProcessingError(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("Video decoding exceeded its time limit."), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop("Video decoder output exceeded its limit.");
      else if (!failure) chunks.push(chunk);
    });
    // Drain diagnostics without reflecting local paths or media-controlled text.
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      failure = new VideoProcessingError(
        `Install ${binary} and make it available on PATH to process videos.`,
      );
      reject(failure);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0)
        reject(
          new VideoProcessingError("Unable to decode this video. Use a valid MP4 or WebM file."),
        );
      else resolveResult(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Pure image stage, also used by deterministic pipeline contract tests. */
export function buildVideoSheet(
  input: ImageData[],
  rawOptions: Partial<ProcessingOptions> = {},
  decodedInterval?: VideoInterval,
) {
  const options = validateVideoProcessing(rawOptions);
  if (!input.length || input.length > MAX_FRAMES)
    throw new VideoProcessingError("Video must contain 1–120 sampled frames.");
  const width = input[0].width;
  const height = input[0].height;
  if (
    width < 1 ||
    height < 1 ||
    width * height > 512 * 512 ||
    input.some((f) => f.width !== width || f.height !== height)
  ) {
    throw new VideoProcessingError("Decoded video frames exceed the allowed dimensions.");
  }
  const allKeyed = input.map((frame) => {
    const image = new ImageData(new Uint8ClampedArray(frame.data), width, height);
    applyChromaKeyToImageData(image, hexToRgb(options.backgroundColor), {
      mode: "chroma-transparent",
      similarity: options.tolerance,
      softness: options.softness,
      spill: options.spill,
      choke: options.choke,
    });
    return image;
  });
  const selected = selectVideoFrames(allKeyed, options, decodedInterval);
  const keyed = selected.frames;
  const bounds = keyed.map(computeTrimRect).filter((b) => b !== null);
  if (!bounds.length)
    throw new VideoProcessingError(
      "Background removal left no visible pixels. Change the background color or tolerance.",
    );
  const x = Math.max(0, Math.min(...bounds.map((b) => b.x)) - options.padding);
  const y = Math.max(0, Math.min(...bounds.map((b) => b.y)) - options.padding);
  const right = Math.min(width, Math.max(...bounds.map((b) => b.x + b.w)) + options.padding);
  const bottom = Math.min(height, Math.max(...bounds.map((b) => b.y + b.h)) + options.padding);
  const crop = { x, y, width: right - x, height: bottom - y };
  const frameWidth = options.frameWidth;
  const frameHeight = Math.max(1, Math.round((crop.height / crop.width) * frameWidth));
  const cols = Math.min(options.columns, keyed.length);
  const rows = Math.ceil(keyed.length / cols);
  if (frameHeight > 1024 || frameWidth * frameHeight * cols * rows > MAX_SHEET_PIXELS) {
    throw new VideoProcessingError(
      "Output sheet exceeds the pixel limit. Reduce frame width or sampling rate.",
    );
  }
  const frames = keyed.map((frame) => {
    const image = new ImageData(frameWidth, frameHeight);
    for (let py = 0; py < frameHeight; py++) {
      const sy = y + Math.min(crop.height - 1, Math.floor((py * crop.height) / frameHeight));
      for (let px = 0; px < frameWidth; px++) {
        const sx = x + Math.min(crop.width - 1, Math.floor((px * crop.width) / frameWidth));
        const from = (sy * width + sx) * 4;
        image.data.set(frame.data.subarray(from, from + 4), (py * frameWidth + px) * 4);
      }
    }
    return image;
  });
  const sheet = stitchSheet(frames, cols, rows);
  const cell = (index: number) => ({ row: Math.floor(index / cols), col: index % cols });
  const metadata = {
    source: "sheet.png",
    sourceWidth: sheet.width,
    sourceHeight: sheet.height,
    frameWidth,
    frameHeight,
    frameCount: frames.length,
    grid: { cols, rows },
    frameDurations: selected.frameDurations,
    sourceFrameIndices: selected.sourceFrameIndices,
    sourceFrameTimesSeconds: selected.sourceFrameTimesSeconds,
    selection: selected.selection,
    tags: [
      {
        name: options.name,
        from: 0,
        to: frames.length - 1,
        fps: options.fps,
        direction: "forward",
      },
    ],
    pivots: frames.map((_, index) => ({
      index,
      cell: cell(index),
      pivot: { x: Math.round((frameWidth - 1) / 2), y: frameHeight - 1 },
    })),
    hitboxes: frames.map((frame, index) => {
      const rect = computeTrimRect(frame);
      return {
        index,
        cell: cell(index),
        type: "aabb",
        bounds: rect ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h } : null,
      };
    }),
    collision: frames.map((frame, index) => {
      const outline = generateOutline(frame, {
        alphaThreshold: 32,
        simplifyTolerance: 1,
        convexHull: false,
      });
      return {
        index,
        cell: cell(index),
        bounds: outline.bounds,
        pointCount: outline.polygon.length,
        polygon: outline.polygon.map((p) => [p.x, p.y]),
      };
    }),
    processing: { ...options, crop, decodedWidth: width, decodedHeight: height },
    collisionNote:
      "Collision polygons trace the first connected region; detached regions and holes are not traced. Hitbox AABBs enclose all nontransparent pixels, including detached regions. Both use frame-local coordinates; review for gameplay.",
  };
  return { sheet, metadata };
}

export async function processVideo({
  videoPath,
  outputDir,
  options: rawOptions = {},
}: {
  videoPath: string;
  outputDir: string;
  options?: Partial<ProcessingOptions>;
}): Promise<{ videoPath: string; sheetPath: string; metadataPath: string }> {
  const options = validateVideoProcessing(rawOptions);
  if (!isAbsolute(videoPath) || !isAbsolute(outputDir))
    throw new VideoProcessingError("Video processing requires absolute local paths.");
  const file = await stat(videoPath);
  if (!file.isFile() || file.size > MAX_VIDEO_BYTES || file.size === 0)
    throw new VideoProcessingError(
      `Video must be a local file of at most ${MAX_VIDEO_BYTES / 1024 / 1024} MiB.`,
    );
  const input = resolve(videoPath);
  const info = JSON.parse(
    await runMedia("ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska,webm",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration:format=duration",
      "-of",
      "json",
      input,
    ]),
  ) as {
    streams?: Array<{ width?: number; height?: number; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  const duration = Number(info.format?.duration ?? stream?.duration);
  const width = stream?.width ?? 0;
  const height = stream?.height ?? 0;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 30 ||
    width < 1 ||
    height < 1 ||
    width * height > 8_388_608
  ) {
    throw new VideoProcessingError(
      "Video must be at most 30 seconds and 8 megapixels, with a valid duration.",
    );
  }
  const trim = resolveVideoTrim(duration, options);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(outputDir, ".frames-"));
  try {
    const dw = Math.max(1, Math.round(width * Math.min(1, 512 / width, 512 / height)));
    const dh = Math.max(1, Math.round(height * Math.min(1, 512 / width, 512 / height)));
    await runMedia("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska,webm",
      "-ss",
      String(trim.startSeconds),
      "-i",
      input,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-t",
      String(trim.endSeconds - trim.startSeconds),
      "-vf",
      `setpts=PTS-STARTPTS,fps=${options.fps}:round=up,scale=${dw}:${dh}:flags=lanczos`,
      "-frames:v",
      String(MAX_FRAMES),
      "-threads",
      "1",
      join(scratch, "frame-%04d.png"),
    ]);
    const names = (await readdir(scratch)).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
    const { sheet, metadata } = buildVideoSheet(
      names.map((name) => loadPng(join(scratch, name))),
      options,
      trim,
    );
    const sheetPath = join(outputDir, "sheet.png");
    const metadataPath = join(outputDir, "metadata.json");
    savePng(sheet, sheetPath);
    await chmod(sheetPath, 0o600);
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, video: { durationSeconds: duration, width, height, file: "video.mp4" } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return { videoPath: input, sheetPath, metadataPath };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
