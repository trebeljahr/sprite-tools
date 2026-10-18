import { meanAbsoluteDifference, type FrameImageLike } from "../pipeline/dedupe-core";
import { validateProcessing, type ProcessingOptions } from "./schema";

/** Only messages authored by the processor may reach the Web/MCP UI. */
export class VideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoProcessingError";
  }
}

export interface VideoInterval {
  startSeconds: number;
  endSeconds: number;
}

export interface VideoSelection extends VideoInterval {
  durationSeconds: number;
  inputFrameCount: number;
  outputFrameCount: number;
  loopMode: "full" | "auto";
  /** Mean RGBA difference on shared-crop thumbnails; lower is better, not a guarantee. */
  seamScore?: number;
  loopFound?: boolean;
  note?: string;
}

export function validateVideoProcessing(input: unknown): ProcessingOptions {
  try {
    return validateProcessing(input);
  } catch (error) {
    // validateProcessing only emits fixed, authored messages, never input values.
    throw new VideoProcessingError(
      error instanceof Error ? error.message : "Invalid sprite processing settings.",
    );
  }
}

/** Shared paid-request preflight and decoder guard. maxFrames never raises the decode cap. */
export function resolveVideoTrim(
  durationSeconds: number,
  options: ProcessingOptions,
): VideoInterval {
  const { startSeconds, endSeconds = durationSeconds } = validateVideoProcessing(options);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 30 ||
    startSeconds >= durationSeconds ||
    endSeconds > durationSeconds ||
    endSeconds - startSeconds < 0.001
  ) {
    throw new VideoProcessingError(
      "Trim must be within the video and at least one millisecond long.",
    );
  }
  if (Math.ceil((endSeconds - startSeconds) * options.fps - 1e-9) > 120) {
    throw new VideoProcessingError(
      "Sampling would exceed 120 frames. Trim the video or reduce the sampling rate.",
    );
  }
  return { startSeconds, endSeconds };
}

interface HeldFrame {
  sourceIndex: number;
  sourceTime: number;
  startMs: number;
  endMs: number;
}

/** A shared foreground crop preserves translation while avoiding dilution by an empty canvas. */
function comparisonSampler(frames: FrameImageLike[], maxEdge: number) {
  const { width, height } = frames[0];
  let left = width,
    top = height,
    right = 0,
    bottom = 0;
  for (const frame of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (frame.data[(y * width + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }
  if (right <= left || bottom <= top) {
    return (_frame: FrameImageLike): FrameImageLike => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    });
  }
  const cropWidth = right - left,
    cropHeight = bottom - top;
  const scale = Math.min(1, maxEdge / cropWidth, maxEdge / cropHeight);
  const outWidth = Math.max(1, Math.round(cropWidth * scale));
  const outHeight = Math.max(1, Math.round(cropHeight * scale));
  return (frame: FrameImageLike): FrameImageLike => {
    const data = new Uint8ClampedArray(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
      const y0 = top + Math.floor((y * cropHeight) / outHeight);
      const y1 = top + Math.floor(((y + 1) * cropHeight) / outHeight);
      for (let x = 0; x < outWidth; x++) {
        const x0 = left + Math.floor((x * cropWidth) / outWidth);
        const x1 = left + Math.floor(((x + 1) * cropWidth) / outWidth);
        const sum = [0, 0, 0, 0];
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const offset = (sy * width + sx) * 4;
            const alpha = frame.data[offset + 3];
            if (alpha > 0) {
              for (let channel = 0; channel < 3; channel++)
                sum[channel] += frame.data[offset + channel];
            }
            sum[3] += alpha;
          }
        }
        const area = (x1 - x0) * (y1 - y0);
        for (let channel = 0; channel < 4; channel++) {
          data[(y * outWidth + x) * 4 + channel] = Math.round(sum[channel] / area);
        }
      }
    }
    return { width: outWidth, height: outHeight, data };
  };
}

function suggestLoop(frames: FrameImageLike[], held: HeldFrame[], options: ProcessingOptions) {
  const proxies = frames.map(comparisonSampler(frames, 32));
  const distances = new Map<number, number>();
  const distance = (a: number, b: number) => {
    const key = Math.min(a, b) * frames.length + Math.max(a, b);
    const cached = distances.get(key);
    if (cached !== undefined) return cached;
    const value = meanAbsoluteDifference(proxies[a], proxies[b]);
    distances.set(key, value);
    return value;
  };
  const candidates: Array<{ start: number; end: number; score: number; duration: number }> = [];
  for (let start = 0; start < frames.length - 3; start++) {
    // A clipped first hold is not a shorter period; begin at a complete sampled pose.
    if (held[start].startMs > Math.round(held[start].sourceTime * 1000)) continue;
    // The matching end is excluded from the loop. Its next pose is evidence of motion continuity.
    for (let end = start + 2; end + 1 < frames.length; end++) {
      const duration = (held[end].startMs - held[start].startMs) / 1000;
      if (duration < options.loopMinSeconds) continue;
      if (duration > options.loopMaxSeconds) break;
      const score = (distance(start, end) + distance(start + 1, end + 1)) / 2;
      if (score > 8) continue;
      let motion = 0;
      for (let i = start + 1; i < end; i++) motion = Math.max(motion, distance(start, i));
      // Reject a still pose or compression noise masquerading as a tiny, perfect loop.
      if (motion < Math.max(2, score * 2.5)) continue;
      candidates.push({ start, end, score, duration });
    }
  }
  if (!candidates.length) return undefined;
  const bestScore = Math.min(...candidates.map((candidate) => candidate.score));
  const tolerance = Math.max(0.5, bestScore * 0.15);
  return candidates
    .filter((candidate) => candidate.score <= bestScore + tolerance)
    .sort((a, b) => a.duration - b.duration || a.score - b.score || a.start - b.start)[0];
}

/**
 * Operates on keyed frames, before final cropping/collision. sourceFrameIndices refer to this
 * decoded, FPS-resampled input; sourceFrameTimesSeconds locate each retained pose in the video.
 * decodedInterval is supplied after ffmpeg has already sought/trimmed the input.
 */
export function selectVideoFrames<T extends FrameImageLike>(
  input: T[],
  rawOptions: Partial<ProcessingOptions> = {},
  decodedInterval?: VideoInterval,
) {
  const options = validateVideoProcessing(rawOptions);
  if (!input.length || input.length > 120)
    throw new VideoProcessingError("Video must contain 1–120 sampled frames.");
  const sourceInterval = decodedInterval ?? {
    startSeconds: 0,
    endSeconds: input.length / options.fps,
  };
  const trim = decodedInterval ?? resolveVideoTrim(sourceInterval.endSeconds, options);
  if (decodedInterval) {
    if (
      !Number.isFinite(trim.startSeconds) ||
      !Number.isFinite(trim.endSeconds) ||
      trim.startSeconds < 0 ||
      trim.endSeconds > 30 ||
      trim.endSeconds <= trim.startSeconds
    ) {
      throw new VideoProcessingError("Decoded video interval is invalid.");
    }
    resolveVideoTrim(trim.endSeconds, {
      ...options,
      startSeconds: trim.startSeconds,
      endSeconds: trim.endSeconds,
    });
  }
  let held: HeldFrame[] = [];
  for (let i = 0; i < input.length; i++) {
    const sourceTime = sourceInterval.startSeconds + i / options.fps;
    const nextTime =
      i === input.length - 1
        ? sourceInterval.endSeconds
        : sourceInterval.startSeconds + (i + 1) / options.fps;
    const startMs = Math.round(Math.max(sourceTime, trim.startSeconds) * 1000);
    const endMs = Math.round(Math.min(nextTime, trim.endSeconds) * 1000);
    if (endMs > startMs) held.push({ sourceIndex: i, sourceTime, startMs, endMs });
  }
  if (!held.length) throw new VideoProcessingError("Trim contains no sampled frames.");
  const inputFrameCount = held.length;
  let loopFound: boolean | undefined;
  let seamScore: number | undefined;
  let note: string | undefined;
  if (options.loopMode === "auto") {
    const suggestion = suggestLoop(
      held.map((frame) => input[frame.sourceIndex]),
      held,
      options,
    );
    loopFound = Boolean(suggestion);
    if (suggestion) {
      held = held.slice(suggestion.start, suggestion.end);
      seamScore = Math.round(suggestion.score * 1000) / 1000;
      note = "Suggested loop; review motion across the seam.";
    } else {
      note = "No moving loop found; kept the trimmed clip.";
    }
  }
  const startMs = held[0].startMs;
  const endMs = held[held.length - 1].endMs;
  if (options.dedupeThreshold !== undefined) {
    const merged: HeldFrame[] = [];
    const sample =
      options.dedupeThreshold === 0
        ? (frame: FrameImageLike) => frame
        : comparisonSampler(
            held.map((frame) => input[frame.sourceIndex]),
            Infinity,
          );
    let previousImage: FrameImageLike | undefined;
    for (const frame of held) {
      const previous = merged[merged.length - 1];
      const currentImage = sample(input[frame.sourceIndex]);
      // Adjacent runs only: A B C B must remain A B C B. Compare to retained representatives.
      if (
        previous &&
        previousImage &&
        meanAbsoluteDifference(previousImage, currentImage) <= options.dedupeThreshold
      ) {
        previous.endMs = frame.endMs;
      } else {
        merged.push({ ...frame });
        previousImage = currentImage;
      }
    }
    held = merged;
  }
  if (options.maxFrames !== undefined && held.length > options.maxFrames) {
    const selected = new Set<number>([0, held.length - 1]);
    const lastStartMs = held[held.length - 1].startMs;
    let index = 0;
    for (let i = 1; i < options.maxFrames - 1; i++) {
      const target = startMs + ((lastStartMs - startMs) * i) / (options.maxFrames - 1);
      while (index + 1 < held.length && held[index + 1].startMs <= target) index++;
      selected.add(index);
    }
    const indices = [...selected].sort((a, b) => a - b);
    held = indices.map((source, i) => ({
      ...held[source],
      // Unselected time becomes a hold, never a faster animation or a reordered pose.
      endMs: i + 1 < indices.length ? held[indices[i + 1]].startMs : endMs,
    }));
  }
  const selection: VideoSelection = {
    startSeconds: startMs / 1000,
    endSeconds: endMs / 1000,
    durationSeconds: (endMs - startMs) / 1000,
    inputFrameCount,
    outputFrameCount: held.length,
    loopMode: options.loopMode,
    ...(seamScore === undefined ? {} : { seamScore }),
    ...(loopFound === undefined ? {} : { loopFound, note }),
  };
  return {
    frames: held.map((frame) => input[frame.sourceIndex]),
    sourceFrameIndices: held.map((frame) => frame.sourceIndex),
    sourceFrameTimesSeconds: held.map((frame) => frame.sourceTime),
    frameDurations: held.map((frame) => frame.endMs - frame.startMs),
    selection,
  };
}
