import { describe, it, expect, vi } from "vitest";
import {
  validateAnimationSet,
  frameAt,
  clipFor,
  roleDuration,
  type AnimationSet,
} from "../src/lib/playground/set";
import {
  createBody,
  stepBody,
  bodyFrame,
  stepPreview,
  WORLD,
  type Body,
  type Input,
} from "../src/lib/playground/controller";
import { boundedFile, sameOriginFile } from "../src/lib/browser-files";
const clip = (loop = true) => ({
  sheet: "hero.png",
  grid: { cols: 4, rows: 1 },
  count: 4,
  durations: [100, 100, 100, 100],
  loop,
});
const base = {
  version: 1,
  character: "Test hero",
  canvas: { width: 128, height: 128 },
  origin: { x: 64, y: 120 },
  clips: {
    idle: clip(),
    walk: clip(),
    jump: {
      ...clip(false),
      phase: { takeoff: { from: 0, to: 0 }, air: { from: 1, to: 2 }, land: { from: 3, to: 3 } },
    },
    sweep: { ...clip(false), phase: { active: [1, 2] } },
    stab: { ...clip(false), phase: { active: [1, 2] } },
    cut: { ...clip(false), phase: { active: [1, 2] } },
  },
};
const set = () => validateAnimationSet(base);
const neutral: Input = { axis: 0, sprint: false, jump: false, roll: false, attack: false };
function advance(
  initial: Body,
  seconds: number,
  input: Partial<Input> = {},
  animationSet: AnimationSet = set(),
) {
  let s = initial;
  for (let i = 0; i < Math.ceil(seconds * 120); i++)
    s = stepBody(s, { ...neutral, ...input }, 1 / 120, animationSet);
  return s;
}

describe("controller movement and transitions", () => {
  it("moves at distinct walk and run speeds without modifying the source state", () => {
    const initial = createBody(),
      walk = advance(initial, 0.4, { axis: 1 }),
      run = advance(initial, 0.4, { axis: 1, sprint: true });
    expect(walk.motion).toBe("walk");
    expect(run.motion).toBe("run");
    expect(walk.vx).toBe(230);
    expect(run.vx).toBe(360);
    expect(run.x).toBeGreaterThan(walk.x);
    expect(initial.x).toBe(180);
  });
  it("switches to the run clip immediately when sprint starts and back on release", () => {
    const clips = validateAnimationSet({ ...base, clips: { ...base.clips, run: clip() } });
    const walking = advance(createBody(), 0.3, { axis: 1 }, clips);
    const running = stepBody(walking, { ...neutral, axis: 1, sprint: true }, 1 / 120, clips);
    expect(running.motion).toBe("run");
    expect(clipFor(clips, bodyFrame(running, clips).role).id).toBe("run");
    expect(running.vx).toBeGreaterThan(walking.vx);
    const released = stepBody(running, { ...neutral, axis: 1 }, 1 / 120, clips);
    expect(released.motion).toBe("walk");
  });
  it("carries running velocity and facing into a directed jump", () => {
    const moving = advance(createBody(), 0.3, { axis: -1, sprint: true });
    const airborne = stepBody(
      moving,
      { ...neutral, axis: -1, sprint: true, jump: true },
      1 / 120,
      set(),
    );
    expect(airborne.motion).toBe("jump");
    expect(airborne.vx).toBe(-360);
    expect(airborne.facing).toBe(-1);
    expect(airborne.y).toBeLessThan(WORLD.ground);
  });
  it("keeps the root on the ground for idle and completes a jump with a landing phase", () => {
    let s = advance(createBody(), 1);
    expect(s.y).toBe(500);
    expect(s.grounded).toBe(true);
    s = stepBody(s, { ...neutral, jump: true }, 1 / 120, set());
    let landed = false;
    for (let i = 0; i < 120; i++) {
      s = stepBody(s, neutral, 1 / 120, set());
      if (s.motion === "land") landed = true;
    }
    expect(landed).toBe(true);
    expect(s.grounded).toBe(true);
    expect(s.motion).toBe("idle");
  });
  it("lands on a one-way platform while falling", () => {
    const s = {
      ...createBody(),
      x: 350,
      y: 400,
      vy: 200,
      grounded: false,
      motion: "jump" as const,
    };
    const landed = advance(s, 0.1);
    expect(landed.y).toBe(410);
    expect(landed.grounded).toBe(true);
  });
  it("locks roll direction and queues a stab without interrupting the roll", () => {
    let s = stepBody(createBody(), { ...neutral, roll: true }, 1 / 120, set());
    s = stepBody(s, { ...neutral, axis: -1, attack: true }, 1 / 120, set());
    expect(s.motion).toBe("roll");
    expect(s.facing).toBe(1);
    expect(s.queuedStab).toBe(true);
    s = advance(s, 0.49);
    expect(s.motion).toBe("attack2");
    expect(s.queuedStab).toBe(false);
    expect(s.attack).toBe(2);
  });
  it("buffers a stab when roll and attack arrive in the same physics step", () => {
    let s = stepBody(createBody(), { ...neutral, roll: true, attack: true }, 1 / 120, set());
    expect(s.queuedStab).toBe(true);
    s = advance(s, 0.51);
    expect(s.motion).toBe("attack2");
  });
  it("does not invent an attack when a roll finishes without a buffered input", () => {
    let s = stepBody(createBody(), { ...neutral, roll: true }, 1 / 120, set());
    s = advance(s, 0.55);
    expect(s.motion.startsWith("attack")).toBe(false);
  });
  it("chains a late attack press into the next action", () => {
    let s = stepBody(createBody(), { ...neutral, attack: true }, 1 / 120, set());
    expect(s.motion).toBe("attack1");
    s = advance(s, 0.3);
    s = stepBody(s, { ...neutral, attack: true }, 1 / 120, set());
    s = advance(s, 0.1);
    expect(s.motion).toBe("attack2");
  });
  it("lets an early attack buffer expire instead of endlessly repeating", () => {
    let s = stepBody(createBody(), { ...neutral, attack: true }, 1 / 120, set());
    s = stepBody(s, { ...neutral, attack: true }, 1 / 120, set());
    s = advance(s, 0.5);
    expect(s.motion).toBe("idle");
  });
  it("returns from an attack to locomotion when movement remains held", () => {
    let s = stepBody(createBody(), { ...neutral, attack: true, axis: 1 }, 1 / 120, set());
    s = advance(s, 0.5, { axis: 1, sprint: true });
    expect(s.motion).toBe("run");
    expect(s.vx).toBeGreaterThan(100);
  });
  it("samples airborne and landing frames from phase metadata", () => {
    const s = { ...createBody(), grounded: false, motion: "jump" as const, jumpAge: 0.3, vy: -400 };
    expect(bodyFrame(s, set()).frame).toBe(1);
    expect(bodyFrame({ ...s, motion: "land", time: 0.1 }, set()).frame).toBe(3);
  });
  it("bounds large or negative time steps and keeps the player in the arena", () => {
    const s = createBody();
    expect(stepBody(s, neutral, -1, set())).toEqual(s);
    expect(stepBody(s, { ...neutral, axis: 1 }, 60, set()).x - s.x).toBeLessThan(11);
    expect(advance(s, 10, { axis: 1, sprint: true }).x).toBeLessThan(WORLD.width);
  });
});
describe("clip queues and reusable sets", () => {
  it("finishes the current cycle before entering a queued clip", () => {
    const next = stepPreview({ role: "walk", time: 0.35, queued: "jump" }, 0.1, set());
    expect(next.role).toBe("jump");
    expect(next.time).toBe(0);
    expect(next.queued).toBeNull();
  });
  it("keeps a queued action pending until the cycle ends", () => {
    const next = stepPreview({ role: "walk", time: 0.1, queued: "attack2" }, 0.1, set());
    expect(next.role).toBe("walk");
    expect(next.queued).toBe("attack2");
  });
  it("returns completed one-shot actions to idle", () => {
    expect(stepPreview({ role: "attack1", time: 0.39, queued: null }, 0.05, set()).role).toBe(
      "idle",
    );
  });
  it("accepts custom non-mouse clip names through explicit bindings", () => {
    const s = validateAnimationSet({
      ...base,
      clips: { rest: clip(), flap: clip() },
      controller: { bindings: { idle: "rest", walk: "flap", run: null } },
    });
    expect(clipFor(s, "walk").id).toBe("flap");
    expect(clipFor(s, "run").fallback).toBe(true);
  });
  it("labels missing run and roll clips while keeping their controller durations usable", () => {
    expect(clipFor(set(), "run").id).toBe("walk");
    expect(roleDuration(set(), "run")).toBeCloseTo(0.4 / 1.65);
    expect(roleDuration(set(), "roll")).toBe(0.5);
  });
  it("respects authored run bindings and exact frame boundaries", () => {
    const s = validateAnimationSet({ ...base, clips: { ...base.clips, run: clip() } });
    expect(clipFor(s, "run").fallback).toBe(false);
    expect(frameAt(s, "run", 0.1)).toBe(1);
    expect(frameAt(s, "run", 0.41)).toBe(0);
    expect(frameAt(s, "attack1", 99, false)).toBe(3);
  });
  it("rejects invalid counts, phases, bindings and oversized sheets", () => {
    expect(() =>
      validateAnimationSet({ ...base, clips: { idle: { ...clip(), count: 5 } } }),
    ).toThrow(/agree/);
    expect(() =>
      validateAnimationSet({ ...base, clips: { idle: { ...clip(), phase: { active: [3, 9] } } } }),
    ).toThrow(/phase/);
    expect(() =>
      validateAnimationSet({ ...base, controller: { bindings: { walk: "missing" } } }),
    ).toThrow(/unknown/);
    expect(() =>
      validateAnimationSet({
        ...base,
        canvas: { width: 2048, height: 2048 },
        clips: { idle: { ...clip(), grid: { cols: 64, rows: 64 } } },
      }),
    ).toThrow(/pixels/);
  });
  it("preserves animation provenance and weapon anchors when loading a reusable set", () => {
    const s = validateAnimationSet({
      ...base,
      provenance: { source: "reviewed art" },
      clips: {
        ...base.clips,
        idle: { ...clip(), weapon: [{ frame: 0, grip: { x: 1, y: 2 }, tip: { x: 3, y: 4 } }] },
      },
    });
    expect(s.provenance).toEqual({ source: "reviewed art" });
    expect(s.clips.idle.weapon).toEqual([{ frame: 0, grip: { x: 1, y: 2 }, tip: { x: 3, y: 4 } }]);
  });
  it("keeps per-clip colour settings separate from source filenames and other clips", () => {
    const s = validateAnimationSet({
      ...base,
      clips: {
        ...base.clips,
        walk: { ...clip(), colour: { saturation: 1.4, contrast: 1.04, brightness: 1 } },
      },
    });
    expect(s.clips.walk.colour?.saturation).toBe(1.4);
    expect(s.clips.idle.colour).toBeUndefined();
    expect(s.clips.walk.sheet).toBe("hero.png");
  });
});
describe("bounded same-site project links", () => {
  it("resolves relative local files while rejecting external and credential URLs", () => {
    expect(sameOriginFile("/demo/mouse.zip", "http://127.0.0.1:54937/character-layers")).toBe(
      "http://127.0.0.1:54937/demo/mouse.zip",
    );
    for (const p of [
      "https://evil.test/file.zip",
      "javascript:alert(1)",
      "http://name:secret@127.0.0.1:54937/file.zip",
    ])
      expect(() => sameOriginFile(p, "http://127.0.0.1:54937")).toThrow(/same site/);
  });
  it("loads a bounded project response with no redirects", async () => {
    const request = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3])),
    );
    expect(Array.from(await boundedFile("http://localhost/test", 4, undefined, request))).toEqual([
      1, 2, 3,
    ]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      credentials: "same-origin",
    });
  });
  it("rejects advertised and streamed oversized files", async () => {
    await expect(
      boundedFile(
        "http://localhost/test",
        2,
        undefined,
        async () => new Response("abc", { headers: { "content-length": "3" } }),
      ),
    ).rejects.toThrow(/too large/);
    await expect(
      boundedFile("http://localhost/test", 2, undefined, async () => new Response("abc")),
    ).rejects.toThrow(/too large/);
  });
  it("reports missing files without replacing a local draft", async () => {
    await expect(
      boundedFile(
        "http://localhost/test",
        20,
        undefined,
        async () => new Response("", { status: 404 }),
      ),
    ).rejects.toThrow(/404/);
  });
});
