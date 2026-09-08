import { describe, expect, it } from "vitest";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import {
  applyDurationSpecs,
  type FrameDurations,
  quantizeGifDelayMs,
  resolveSequenceDurationsMs,
} from "@/lib/animation/durations";

// The duration maths is unit-tested in frame-durations.test.ts. What is worth
// checking here is that the numbers survive the encoder: gifenc writes
// `Math.round(delay / 10)` centiseconds into each Graphic Control Extension,
// so the only honest assertion is one made against the bytes on disk.

const W = 4;
const H = 4;

/** One opaque solid-colour frame, in the RGBA layout gifenc expects. */
function solidFrame(r: number, g: number, b: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  return d;
}

const FRAMES = [
  solidFrame(255, 0, 0),
  solidFrame(0, 255, 0),
  solidFrame(0, 0, 255),
  solidFrame(255, 255, 0),
];

/** The same per-frame encode `sprite-tools gif` performs, minus the sheet IO. */
function encodeGif(sequence: number[], delays: number[]): Uint8Array {
  const enc = GIFEncoder();
  sequence.forEach((frameIndex, s) => {
    const d = FRAMES[frameIndex];
    const palette = quantize(d, 256, { format: "rgba4444" });
    const idx = applyPalette(d, palette, "rgba4444");
    enc.writeFrame(idx, W, H, {
      palette,
      delay: delays[s],
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
    });
  });
  enc.finish();
  return enc.bytes();
}

/**
 * Walk the byte stream for Graphic Control Extensions and read each one's
 * delay. A GCE is exactly 8 bytes: 0x21 0xF9 0x04 <packed> <delay lo>
 * <delay hi> <transparent index> 0x00. The delay is little-endian
 * centiseconds, so multiply by 10 to get back to milliseconds. Requiring the
 * trailing block terminator keeps the scan from matching the same byte
 * triple inside LZW image data.
 */
function decodeDelaysMs(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] !== 0x21 || bytes[i + 1] !== 0xf9 || bytes[i + 2] !== 0x04) continue;
    if (bytes[i + 7] !== 0x00) continue;
    out.push((bytes[i + 4] | (bytes[i + 5] << 8)) * 10);
    i += 7;
  }
  return out;
}

/** Full `sprite-tools gif` delay pipeline: resolve, quantize, encode, decode. */
function roundTrip(
  sequence: number[],
  durations: FrameDurations | undefined,
  fps: number,
): number[] {
  const delays = resolveSequenceDurationsMs(sequence, durations, fps).map(quantizeGifDelayMs);
  return decodeDelaysMs(encodeGif(sequence, delays));
}

const FORWARD = [0, 1, 2, 3];

describe("decodeDelaysMs", () => {
  it("finds one delay per written frame", () => {
    expect(roundTrip(FORWARD, undefined, 10)).toHaveLength(4);
    expect(roundTrip([0, 1, 2, 3, 2, 1], undefined, 10)).toHaveLength(6);
  });
});

describe("GIF per-frame delays", () => {
  it("writes uneven holds verbatim when they are whole 10ms units", () => {
    expect(roundTrip(FORWARD, [250, 80, 80, 500], 10)).toEqual([250, 80, 80, 500]);
  });

  it("rounds a hold GIF cannot represent to the nearest 10ms", () => {
    // 125ms sits between two centiseconds and rounds up to 130ms.
    expect(roundTrip(FORWARD, [125, 125, 125, 125], 10)).toEqual([130, 130, 130, 130]);
    // 133ms rounds down; 5ms is below the 20ms floor browsers respect.
    expect(roundTrip(FORWARD, [133, 5, 24, 26], 10)).toEqual([130, 20, 20, 30]);
  });

  it("falls back to the uniform fps delay for frames with no hold", () => {
    // Backward compatibility: no durations at all is exactly today's output.
    expect(roundTrip(FORWARD, undefined, 10)).toEqual([100, 100, 100, 100]);
    expect(roundTrip(FORWARD, [null, null, null, null], 10)).toEqual([100, 100, 100, 100]);
    // 1000/24 = 41.67ms, which lands on 4 centiseconds either way.
    expect(roundTrip(FORWARD, undefined, 24)).toEqual([40, 40, 40, 40]);
  });

  it("mixes explicit holds with the fps fallback", () => {
    expect(roundTrip(FORWARD, [250, null, null, 500], 10)).toEqual([250, 100, 100, 500]);
  });

  it("repeats a frame's hold every time a pingpong sequence plays it", () => {
    const seq = [0, 1, 2, 3, 2, 1];
    expect(roundTrip(seq, [250, 80, null, 500], 10)).toEqual([250, 80, 100, 500, 100, 80]);
  });

  it("carries --duration specs through to the bytes", () => {
    const durations = applyDurationSpecs(["0=250", "1-2=80"], 4);
    expect(roundTrip(FORWARD, durations, 10)).toEqual([250, 80, 80, 100]);
  });

  it("lets a later --duration spec override an earlier baseline", () => {
    // How `--tags-json` plus `--duration` compose: the file is the base.
    const fromFile: FrameDurations = [250, 250, 250, 250];
    const durations = applyDurationSpecs(["2-3=60"], 4, fromFile);
    expect(roundTrip(FORWARD, durations, 10)).toEqual([250, 250, 60, 60]);
  });
});
