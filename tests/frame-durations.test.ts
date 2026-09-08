import { describe, expect, it } from "vitest";
import {
  applyDurationSpecs,
  type FrameDurations,
  fpsToDurationMs,
  GIF_DELAY_QUANTUM_MS,
  GIF_MIN_DELAY_MS,
  normalizeFrameDurations,
  parseDurationSpec,
  quantizeGifDelayMs,
  resolveFrameDurationMs,
  resolveSequenceDurationsMs,
  totalDurationMs,
} from "@/lib/animation/durations";

/** Minimal stand-in for a `sprite-tools tags` document. */
interface TagsDoc {
  frameCount: number;
  frameDurations?: FrameDurations;
  tags: Array<{ name: string; from: number; to: number; fps: number }>;
}

function forwardRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

function pingpong(seq: number[]): number[] {
  return [...seq, ...seq.slice(1, -1).reverse()];
}

describe("fpsToDurationMs", () => {
  it("rounds 1000/fps to whole milliseconds", () => {
    expect(fpsToDurationMs(10)).toBe(100);
    expect(fpsToDurationMs(24)).toBe(42);
    expect(fpsToDurationMs(12)).toBe(83);
  });

  it("guards zero, negative and non-finite rates at 1 fps", () => {
    expect(fpsToDurationMs(0)).toBe(1000);
    expect(fpsToDurationMs(-5)).toBe(1000);
    expect(fpsToDurationMs(Number.NaN)).toBe(1000);
    expect(fpsToDurationMs(Number.POSITIVE_INFINITY)).toBe(1000);
  });
});

describe("backward compatibility", () => {
  // The hard guarantee: a tags document written before frameDurations existed
  // must play back exactly as it does today — one uniform
  // Math.round(1000 / Math.max(1, fps)) per frame, the literal expression the
  // pre-durations GIF encoder used.
  it("a document with no frameDurations produces today's uniform timings", () => {
    const doc: TagsDoc = {
      frameCount: 8,
      tags: [{ name: "run", from: 0, to: 7, fps: 12 }],
    };

    const durations = normalizeFrameDurations(doc.frameDurations, doc.frameCount);
    expect(durations).toBeUndefined();

    const seq = forwardRange(0, 7);
    const resolved = resolveSequenceDurationsMs(seq, durations, doc.tags[0].fps);
    const today = seq.map(() => Math.round(1000 / Math.max(1, doc.tags[0].fps)));
    expect(resolved).toEqual(today);
    expect(resolved).toEqual([83, 83, 83, 83, 83, 83, 83, 83]);
  });

  it("an all-null array is treated as absent, so nothing is emitted", () => {
    expect(normalizeFrameDurations([null, null, null], 3)).toBeUndefined();
    expect(normalizeFrameDurations([0, -1, "nope", Number.NaN], 4)).toBeUndefined();
  });

  it("non-array input is ignored", () => {
    expect(normalizeFrameDurations(undefined, 4)).toBeUndefined();
    expect(normalizeFrameDurations(null, 4)).toBeUndefined();
    expect(normalizeFrameDurations({ 0: 100 }, 4)).toBeUndefined();
    expect(normalizeFrameDurations("100,100", 4)).toBeUndefined();
  });
});

describe("normalizeFrameDurations", () => {
  it("survives a JSON write/read cycle unchanged", () => {
    const doc: TagsDoc = {
      frameCount: 4,
      frameDurations: [250, null, 80, null],
      tags: [{ name: "idle", from: 0, to: 3, fps: 10 }],
    };

    const roundTripped = JSON.parse(JSON.stringify(doc)) as TagsDoc;
    const durations = normalizeFrameDurations(roundTripped.frameDurations, roundTripped.frameCount);

    expect(durations).toEqual([250, null, 80, null]);
    expect(durations).toEqual(doc.frameDurations);
  });

  it("pads a short array and truncates a long one", () => {
    expect(normalizeFrameDurations([100], 3)).toEqual([100, null, null]);
    expect(normalizeFrameDurations([100, 200, 300, 400], 2)).toEqual([100, 200]);
  });

  it("coerces entries: positive numbers round, everything else becomes null", () => {
    expect(normalizeFrameDurations([100.4, 100.6, 0, -20, Number.NaN, "250", "x"], 7)).toEqual([
      100,
      101,
      null,
      null,
      null,
      250,
      null,
    ]);
  });

  it("returns undefined for an empty sheet", () => {
    expect(normalizeFrameDurations([100, 200], 0)).toBeUndefined();
  });
});

describe("resolveFrameDurationMs", () => {
  it("falls back to the tag fps when there is no explicit hold", () => {
    expect(resolveFrameDurationMs(undefined, 0, 10)).toBe(100);
    expect(resolveFrameDurationMs(null, 3, 20)).toBe(50);
    expect(resolveFrameDurationMs([null, 250], 0, 10)).toBe(100);
  });

  it("uses the explicit hold when present", () => {
    expect(resolveFrameDurationMs([null, 250], 1, 10)).toBe(250);
  });

  it("tolerates an out-of-range index", () => {
    expect(resolveFrameDurationMs([250], 9, 10)).toBe(100);
  });
});

describe("partial durations", () => {
  it("keeps explicit holds and falls back to the tag fps for nulls", () => {
    // 2 held frames in a 6-frame sheet; the other 4 stay on the tag's rate.
    const durations = normalizeFrameDurations([400, null, null, 400, null, null], 6);
    const seq = forwardRange(0, 5);

    expect(resolveSequenceDurationsMs(seq, durations, 10)).toEqual([400, 100, 100, 400, 100, 100]);
    // Same durations, different tag fps: only the nulls move.
    expect(resolveSequenceDurationsMs(seq, durations, 20)).toEqual([400, 50, 50, 400, 50, 50]);
    expect(totalDurationMs(seq, durations, 10)).toBe(1200);
  });

  it("totals a sequence with no durations at the uniform rate", () => {
    expect(totalDurationMs(forwardRange(0, 3), undefined, 10)).toBe(400);
  });
});

describe("pingpong sequences", () => {
  it("repeats a held frame's duration on the way back", () => {
    const durations = normalizeFrameDurations([null, 300, null, null], 4);
    const seq = pingpong(forwardRange(0, 3)); // 0,1,2,3,2,1

    expect(seq).toEqual([0, 1, 2, 3, 2, 1]);
    expect(resolveSequenceDurationsMs(seq, durations, 10)).toEqual([100, 300, 100, 100, 100, 300]);
    // The 300ms hold on frame 1 is paid twice: once out, once back.
    expect(totalDurationMs(seq, durations, 10)).toBe(1000);
  });
});

describe("quantizeGifDelayMs", () => {
  it("snaps to the 10ms GIF quantum, honestly", () => {
    expect(quantizeGifDelayMs(125)).toBe(130);
    expect(quantizeGifDelayMs(100)).toBe(100);
    expect(quantizeGifDelayMs(133)).toBe(130);
    expect(quantizeGifDelayMs(5)).toBe(20);
    expect(quantizeGifDelayMs(0)).toBe(20);
  });

  it("never drops below the browser floor", () => {
    expect(quantizeGifDelayMs(-100)).toBe(GIF_MIN_DELAY_MS);
    expect(quantizeGifDelayMs(Number.NaN)).toBe(GIF_MIN_DELAY_MS);
    expect(quantizeGifDelayMs(19)).toBe(GIF_MIN_DELAY_MS);
  });

  it("is a fixed point of what gifenc writes to disk", () => {
    // gifenc writes Math.round(delay / 10) centiseconds, so the effective
    // on-disk delay is Math.round(ms / 10) * 10. Quantizing again is a no-op.
    for (const ms of [20, 33, 41, 100, 125, 133, 250, 1000]) {
      const q = quantizeGifDelayMs(ms);
      expect(q % GIF_DELAY_QUANTUM_MS).toBe(0);
      expect(Math.round(q / GIF_DELAY_QUANTUM_MS) * GIF_DELAY_QUANTUM_MS).toBe(q);
      expect(quantizeGifDelayMs(q)).toBe(q);
    }
  });

  it("matches the pre-durations uniform delay for a plain fps", () => {
    for (const fps of [1, 5, 10, 12, 24, 60]) {
      expect(quantizeGifDelayMs(fpsToDurationMs(fps))).toBe(
        Math.max(20, Math.round(Math.round(1000 / fps) / 10) * 10),
      );
    }
  });
});

describe("parseDurationSpec", () => {
  it("accepts a single index", () => {
    expect(parseDurationSpec("3=250", 8)).toEqual({ from: 3, to: 3, ms: 250 });
  });

  it("accepts an inclusive range", () => {
    expect(parseDurationSpec("2-5=250", 8)).toEqual({ from: 2, to: 5, ms: 250 });
  });

  it("clamps out-of-range indices into the sheet", () => {
    expect(parseDurationSpec("-4=100", 8)).toEqual({ from: 0, to: 0, ms: 100 });
    expect(parseDurationSpec("6-99=100", 8)).toEqual({ from: 6, to: 7, ms: 100 });
  });

  it("normalises a reversed range", () => {
    expect(parseDurationSpec("5-2=100", 8)).toEqual({ from: 2, to: 5, ms: 100 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDurationSpec(" 1-2 = 60 ", 8)).toEqual({ from: 1, to: 2, ms: 60 });
  });

  it("rejects garbage", () => {
    expect(() => parseDurationSpec("250", 8)).toThrow(/missing|expected "index=ms"/);
    expect(() => parseDurationSpec("=250", 8)).toThrow(/expected "index=ms"/);
    expect(() => parseDurationSpec("a-b=250", 8)).toThrow(/expected "index=ms"/);
    expect(() => parseDurationSpec("2-5=", 8)).toThrow(/positive integer/);
    expect(() => parseDurationSpec("2-5=0", 8)).toThrow(/positive integer/);
    expect(() => parseDurationSpec("2-5=-30", 8)).toThrow(/positive integer/);
    expect(() => parseDurationSpec("2-5=abc", 8)).toThrow(/positive integer/);
  });

  it("quotes the offending spec in the message, like parseTag does", () => {
    expect(() => parseDurationSpec("nope", 8)).toThrow('invalid --duration "nope"');
  });
});

describe("applyDurationSpecs", () => {
  it("returns undefined when no specs are given", () => {
    expect(applyDurationSpecs([], 8)).toBeUndefined();
  });

  it("folds specs into an all-null base", () => {
    expect(applyDurationSpecs(["0=300", "2-3=80"], 5)).toEqual([300, null, 80, 80, null]);
  });

  it("lets later specs overwrite earlier ones on overlap", () => {
    expect(applyDurationSpecs(["0-3=100", "2=500"], 4)).toEqual([100, 100, 500, 100]);
  });

  it("layers onto an existing base without dropping it", () => {
    const base = normalizeFrameDurations([250, null, null, null], 4);
    expect(applyDurationSpecs(["3=90"], 4, base)).toEqual([250, null, null, 90]);
    // The base alone is preserved when there are no specs.
    expect(applyDurationSpecs([], 4, base)).toEqual([250, null, null, null]);
  });

  it("returns undefined for an empty sheet", () => {
    expect(applyDurationSpecs(["0=100"], 0)).toBeUndefined();
  });
});
