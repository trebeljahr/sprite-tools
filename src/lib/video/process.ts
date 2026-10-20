import "../../../cli/lib/imagedata-shim";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadPng, savePng, readPngSize } from "../../../cli/lib/image-io";
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
const ANALYSIS_MAX_EDGE = 512;
const MAX_EXTRACTION_EDGE = 1920;
const MAX_SELECTED_PIXELS = 33_554_432;
const MAX_SCRATCH_BYTES = 160 * 1024 * 1024;

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

type FrameSelection = Pick<
  ReturnType<typeof selectVideoFrames>,
  "frameDurations" | "sourceFrameIndices" | "sourceFrameTimesSeconds" | "selection"
>;
interface Dimensions {
  width: number;
  height: number;
}
function keyFrame(image: ImageData, options: ProcessingOptions): ImageData {
  applyChromaKeyToImageData(image, hexToRgb(options.backgroundColor), {
    mode: "chroma-transparent",
    similarity: options.tolerance,
    softness: options.softness,
    spill: options.spill,
    choke: options.choke,
  });
  return image;
}
function timingOf(selected: ReturnType<typeof selectVideoFrames>): FrameSelection {
  return {
    frameDurations: selected.frameDurations,
    sourceFrameIndices: selected.sourceFrameIndices,
    sourceFrameTimesSeconds: selected.sourceFrameTimesSeconds,
    selection: selected.selection,
  };
}

/**
 * Reads one selected, keyed frame at a time: first for the shared crop, then for the sheet.
 * Timing is supplied by the analysis pass and never resampled at the extraction resolution.
 */
export function buildSelectedVideoSheet(
  readFrame: (index: number) => ImageData,
  selected: FrameSelection,
  dimensions: Dimensions,
  rawOptions: Partial<ProcessingOptions> = {},
  analysisDimensions: Dimensions = dimensions,
) {
  const options = validateVideoProcessing(rawOptions);
  const { width, height } = dimensions;
  const count = selected.sourceFrameIndices.length;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_EXTRACTION_EDGE ||
    height > MAX_EXTRACTION_EDGE ||
    count < 1 ||
    count > MAX_FRAMES ||
    selected.frameDurations.length !== count ||
    selected.sourceFrameTimesSeconds.length !== count
  )
    throw new VideoProcessingError("Selected video frames exceed the allowed dimensions or count.");
  const read = (index: number) => {
    const frame = readFrame(index);
    if (frame.width !== width || frame.height !== height)
      throw new VideoProcessingError("Decoded video frames have inconsistent dimensions.");
    return frame;
  };
  let left = width,
    top = height,
    right = 0,
    bottom = 0;
  for (let index = 0; index < count; index++) {
    const bounds = computeTrimRect(read(index));
    if (!bounds) continue;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.w);
    bottom = Math.max(bottom, bounds.y + bounds.h);
  }
  if (right <= left || bottom <= top)
    throw new VideoProcessingError(
      "Background removal left no visible pixels. Change the background color or tolerance.",
    );
  const x = Math.max(0, left - options.padding);
  const y = Math.max(0, top - options.padding);
  right = Math.min(width, right + options.padding);
  bottom = Math.min(height, bottom + options.padding);
  const crop = { x, y, width: right - x, height: bottom - y };
  const frameWidth = options.frameWidth;
  const frameHeight = Math.max(1, Math.round((crop.height / crop.width) * frameWidth));
  const cols = Math.min(options.columns, count);
  const rows = Math.ceil(count / cols);
  if (
    frameHeight > MAX_EXTRACTION_EDGE ||
    frameWidth * frameHeight * cols * rows > MAX_SHEET_PIXELS
  )
    throw new VideoProcessingError(
      "Output sheet exceeds the pixel limit. Reduce frame width or the frame budget.",
    );
  // Check the complete grid, including blank tail cells, before allocating it.
  const sheet = new ImageData(frameWidth * cols, frameHeight * rows);
  const cell = (index: number) => ({ row: Math.floor(index / cols), col: index % cols });
  const pivots = [];
  const hitboxes = [];
  const collision = [];
  for (let index = 0; index < count; index++) {
    const frame = read(index);
    const image = new ImageData(frameWidth, frameHeight);
    for (let py = 0; py < frameHeight; py++) {
      const sy = y + Math.min(crop.height - 1, Math.floor((py * crop.height) / frameHeight));
      for (let px = 0; px < frameWidth; px++) {
        const sx = x + Math.min(crop.width - 1, Math.floor((px * crop.width) / frameWidth));
        const from = (sy * width + sx) * 4;
        image.data.set(frame.data.subarray(from, from + 4), (py * frameWidth + px) * 4);
      }
      const destination =
        ((Math.floor(index / cols) * frameHeight + py) * sheet.width +
          (index % cols) * frameWidth) *
        4;
      sheet.data.set(
        image.data.subarray(py * frameWidth * 4, (py + 1) * frameWidth * 4),
        destination,
      );
    }
    pivots.push({
      index,
      cell: cell(index),
      pivot: { x: Math.round((frameWidth - 1) / 2), y: frameHeight - 1 },
    });
    const rect = computeTrimRect(image);
    hitboxes.push({
      index,
      cell: cell(index),
      type: "aabb",
      bounds: rect ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h } : null,
    });
    const outline = generateOutline(image, {
      alphaThreshold: 32,
      simplifyTolerance: 1,
      convexHull: false,
    });
    collision.push({
      index,
      cell: cell(index),
      bounds: outline.bounds,
      pointCount: outline.polygon.length,
      polygon: outline.polygon.map((p) => [p.x, p.y]),
    });
  }
  const metadata = {
    source: "sheet.png",
    sourceWidth: sheet.width,
    sourceHeight: sheet.height,
    frameWidth,
    frameHeight,
    frameCount: count,
    grid: { cols, rows },
    frameDurations: selected.frameDurations,
    sourceFrameIndices: selected.sourceFrameIndices,
    sourceFrameTimesSeconds: selected.sourceFrameTimesSeconds,
    selection: selected.selection,
    tags: [{ name: options.name, from: 0, to: count - 1, fps: options.fps, direction: "forward" }],
    pivots,
    hitboxes,
    collision,
    processing: {
      ...options,
      crop,
      decodedWidth: width,
      decodedHeight: height,
      analysisWidth: analysisDimensions.width,
      analysisHeight: analysisDimensions.height,
    },
    collisionNote:
      "Collision polygons trace the first connected region; detached regions and holes are not traced. Hitbox AABBs enclose all nontransparent pixels, including detached regions. Both use frame-local coordinates; review for gameplay.",
  };
  return { sheet, metadata };
}

/** Pure analysis and image stage for existing callers and deterministic contract tests. */
export function buildVideoSheet(
  input: ImageData[],
  rawOptions: Partial<ProcessingOptions> = {},
  decodedInterval?: VideoInterval,
) {
  const options = validateVideoProcessing(rawOptions);
  if (!input.length || input.length > MAX_FRAMES)
    throw new VideoProcessingError("Video must contain 1–120 sampled frames.");
  const { width, height } = input[0];
  if (
    width < 1 ||
    height < 1 ||
    width * height > ANALYSIS_MAX_EDGE ** 2 ||
    input.some((f) => f.width !== width || f.height !== height)
  )
    throw new VideoProcessingError("Decoded video frames exceed the allowed dimensions.");
  const keyed = input.map((frame) =>
    keyFrame(new ImageData(new Uint8ClampedArray(frame.data), width, height), options),
  );
  const selected = selectVideoFrames(keyed, options, decodedInterval);
  return buildSelectedVideoSheet(
    (index) => selected.frames[index],
    timingOf(selected),
    { width, height },
    options,
  );
}
function scaledDimensions(width: number, height: number, maxEdge: number): Dimensions {
  const scale = Math.min(1, maxEdge / width, maxEdge / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
/** Check worst-case selected PNG storage before asking ffmpeg to create it. */
export function assertSelectedExtractionBounds(count: number, dimensions: Dimensions): void {
  const { width, height } = dimensions;
  const pixels = count * width * height;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_FRAMES ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_EXTRACTION_EDGE ||
    height > MAX_EXTRACTION_EDGE ||
    pixels > MAX_SELECTED_PIXELS ||
    pixels * 4 + count * 65_536 > MAX_SCRATCH_BYTES
  )
    throw new VideoProcessingError(
      "Selected video frames exceed the extraction limit. Reduce the frame budget or extraction detail.",
    );
}
async function framePaths(
  directory: string,
  dimensions: Dimensions,
  expectedCount?: number,
): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
  if (
    !names.length ||
    names.length > MAX_FRAMES ||
    (expectedCount !== undefined && names.length !== expectedCount)
  )
    throw new VideoProcessingError("Video decoder did not return the selected source frames.");
  let bytes = 0;
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path);
    bytes += info.size;
    if (
      !info.isFile() ||
      info.size > dimensions.width * dimensions.height * 4 + 65_536 ||
      bytes > MAX_SCRATCH_BYTES
    )
      throw new VideoProcessingError(
        "Selected video frames exceed the local scratch limit. Reduce the frame budget or extraction detail.",
      );
    const actual = readPngSize(path);
    if (actual?.width !== dimensions.width || actual?.height !== dimensions.height)
      throw new VideoProcessingError("Decoded video frames have inconsistent dimensions.");
  }
  return names.map((name) => join(directory, name));
}
function analyzeFrames(
  paths: string[],
  options: ProcessingOptions,
  trim: VideoInterval,
): FrameSelection {
  const keyed = paths.map((path) => keyFrame(loadPng(path), options));
  return timingOf(selectVideoFrames(keyed, options, trim));
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
    const analysis = scaledDimensions(width, height, ANALYSIS_MAX_EDGE);
    const extraction = scaledDimensions(width, height, options.extractionMaxEdge);
    const decode = (directory: string, dimensions: Dimensions, indices?: number[]) => {
      const select = indices
        ? `,select=${indices.map((index) => `eq(n\\,${index})`).join("+")}`
        : "";
      return runMedia("ffmpeg", [
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
        `setpts=PTS-STARTPTS,fps=${options.fps}:round=up${select},scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
        "-fps_mode",
        "passthrough",
        "-frames:v",
        String(indices?.length ?? MAX_FRAMES),
        "-threads",
        "1",
        join(directory, "frame-%04d.png"),
      ]);
    };
    const analysisDirectory = join(scratch, "analysis");
    await mkdir(analysisDirectory, { mode: 0o700 });
    await decode(analysisDirectory, analysis);
    const proxies = await framePaths(analysisDirectory, analysis);
    const selected = analyzeFrames(proxies, options, trim);
    let selectedPaths = selected.sourceFrameIndices.map((index) => proxies[index]);
    if (extraction.width !== analysis.width || extraction.height !== analysis.height) {
      assertSelectedExtractionBounds(selectedPaths.length, extraction);
      // Analysis pixels are no longer needed. Keep only one bounded PNG set on disk.
      await rm(analysisDirectory, { recursive: true, force: true });
      const selectedDirectory = join(scratch, "selected");
      await mkdir(selectedDirectory, { mode: 0o700 });
      await decode(selectedDirectory, extraction, selected.sourceFrameIndices);
      selectedPaths = await framePaths(selectedDirectory, extraction, selectedPaths.length);
    }
    const { sheet, metadata } = buildSelectedVideoSheet(
      (index) => keyFrame(loadPng(selectedPaths[index]), options),
      selected,
      extraction,
      options,
      analysis,
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
