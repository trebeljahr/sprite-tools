import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPng, savePng } from "../cli/lib/image-io";
import {
  assertSelectedExtractionBounds,
  buildSelectedVideoSheet,
  processVideo,
} from "../src/lib/video/process";
import { selectVideoFrames } from "../src/lib/video/loop";
import { validateProcessing } from "../src/lib/video/schema";

describe("video extraction bounds", () => {
  it("keeps old recipes at 512 while accepting 720p and 1080p extraction", () => {
    expect(validateProcessing({ frameWidth: 128 }).extractionMaxEdge).toBe(512);
    expect(validateProcessing({ extractionMaxEdge: 1280, frameWidth: 1280 }).frameWidth).toBe(1280);
    expect(validateProcessing({ extractionMaxEdge: 1920, frameWidth: 1920 }).frameWidth).toBe(1920);
    expect(() => validateProcessing({ extractionMaxEdge: 4096 })).toThrow();
    expect(() => validateProcessing({ frameWidth: 1921 })).toThrow();
  });

  it("rejects excessive selected storage before decoding those frames", () => {
    expect(() => assertSelectedExtractionBounds(16, { width: 1920, height: 1080 })).not.toThrow();
    expect(() => assertSelectedExtractionBounds(17, { width: 1920, height: 1080 })).toThrow(
      /extraction limit/,
    );
    expect(() => assertSelectedExtractionBounds(120, { width: 512, height: 512 })).not.toThrow();
    expect(() => assertSelectedExtractionBounds(1, { width: 4096, height: 1 })).toThrow(
      /extraction limit/,
    );
  });

  it("checks the entire output grid before allocating or reading frames for composition", () => {
    const frame = new ImageData(16, 16);
    frame.data.fill(255);
    const selected = selectVideoFrames(Array(5).fill(frame));
    let reads = 0;
    expect(() =>
      buildSelectedVideoSheet(
        () => {
          reads++;
          return frame;
        },
        selected,
        { width: 16, height: 16 },
        { frameWidth: 1920, columns: 4 },
      ),
    ).toThrow(/Output sheet exceeds/);
    expect(reads).toBe(5);
  });
});

describe("two-pass local video extraction", () => {
  let directory: string;
  let videoPath: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "sprite-video-resolution-test-"));
    // Lossless RGB MP4 makes individual source pixels and pose markers testable.
    const frame = new ImageData(1280, 720);
    for (let index = 0; index < 8; index++) {
      for (let y = 0; y < frame.height; y++) {
        for (let x = 0; x < frame.width; x++) {
          const pixel =
            y < 100 || y >= 620
              ? [0, 255, 0, 255]
              : x === 601
                ? [0, 0, 255, 255]
                : [100 + index * 10, 20, 20, 255];
          frame.data.set(pixel, (y * frame.width + x) * 4);
        }
      }
      savePng(frame, join(directory, `input-${String(index).padStart(2, "0")}.png`));
    }
    videoPath = join(directory, "input.mp4");
    const encoded = spawnSync(
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
        join(directory, "input-%02d.png"),
        "-c:v",
        "libx264rgb",
        "-crf",
        "0",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-pix_fmt",
        "rgb24",
        videoPath,
      ],
      { timeout: 20_000, maxBuffer: 64 * 1024, shell: false },
    );
    if (encoded.error) throw encoded.error;
    expect(encoded.status, encoded.stderr.toString()).toBe(0);
  }, 30_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves source poses, nonzero trim and variable holds while retaining one-pixel detail", async () => {
    const options = {
      fps: 8,
      startSeconds: 0.1,
      endSeconds: 0.93,
      maxFrames: 4,
      frameWidth: 1280,
      columns: 2,
      padding: 0,
      softness: 0,
      spill: 0,
      choke: 0,
    };
    const legacy = await processVideo({
      videoPath,
      outputDir: join(directory, "legacy"),
      options,
    });
    const detail = await processVideo({
      videoPath,
      outputDir: join(directory, "detail"),
      options: { ...options, extractionMaxEdge: 1280 },
    });
    const previous = JSON.parse(await readFile(legacy.metadataPath, "utf8"));
    const current = JSON.parse(await readFile(detail.metadataPath, "utf8"));
    expect(previous.processing).toMatchObject({
      extractionMaxEdge: 512,
      decodedWidth: 512,
      decodedHeight: 288,
    });
    expect(current.processing).toMatchObject({
      decodedWidth: 1280,
      decodedHeight: 720,
      analysisWidth: 512,
      analysisHeight: 288,
      crop: { x: 0, y: 100, width: 1280, height: 520 },
    });
    expect(current.sourceFrameIndices).toEqual(previous.sourceFrameIndices);
    expect(current.sourceFrameIndices).toEqual([0, 2, 4, 6]);
    expect(current.sourceFrameTimesSeconds).toEqual(previous.sourceFrameTimesSeconds);
    expect(current.sourceFrameTimesSeconds[0]).toBe(0.1);
    expect(current.frameDurations).toEqual(previous.frameDurations);
    expect(current.frameDurations).toEqual([250, 250, 250, 80]);
    expect(current.selection).toEqual(previous.selection);
    expect(current.selection.durationSeconds).toBe(0.83);
    expect(current.frameDurations.reduce((sum: number, ms: number) => sum + ms, 0)).toBe(830);
    const sheet = loadPng(detail.sheetPath);
    const pixelAt = (index: number, x: number) => {
      const y = Math.floor(index / 2) * 520 + 260;
      const offset = (y * sheet.width + (index % 2) * 1280 + x) * 4;
      return [...sheet.data.subarray(offset, offset + 4)];
    };
    for (let index = 0; index < 4; index++) {
      expect(pixelAt(index, 601)).toEqual([0, 0, 255, 255]);
      // The seek discards source pose zero; each retained pose stays attached to its pixels.
      expect(pixelAt(index, 600)).toEqual([110 + index * 20, 20, 20, 255]);
      expect(pixelAt(index, 602)).toEqual(pixelAt(index, 600));
    }
    const lowDetail = loadPng(legacy.sheetPath);
    let exactBlue = 0;
    for (let x = 0; x < 1280; x++) {
      const offset = (Math.floor(previous.frameHeight / 2) * lowDetail.width + x) * 4;
      if (
        lowDetail.data[offset] === 0 &&
        lowDetail.data[offset + 1] === 0 &&
        lowDetail.data[offset + 2] === 255
      )
        exactBlue++;
    }
    expect(exactBlue).toBe(0);
    expect(
      (await readdir(join(directory, "detail"))).some((name) => name.startsWith(".frames-")),
    ).toBe(false);
  }, 30_000);

  it("cleans both-pass scratch when the selected output exceeds the sheet limit", async () => {
    const outputDir = join(directory, "rejected");
    await expect(
      processVideo({
        videoPath,
        outputDir,
        options: {
          fps: 24,
          startSeconds: 0.1,
          endSeconds: 0.93,
          extractionMaxEdge: 1280,
          frameWidth: 1920,
          columns: 8,
          padding: 0,
          choke: 0,
        },
      }),
    ).rejects.toThrow(/Output sheet exceeds/);
    expect(await readdir(outputDir)).toEqual([]);
  }, 30_000);
});
