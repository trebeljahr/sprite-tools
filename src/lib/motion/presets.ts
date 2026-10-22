import { composite, insidePolygon, pixels } from "../character/core";
import type { CharacterPart, CharacterPlan } from "../character/types";
import {
  ROLE_PARENT,
  autoBind,
  type JointRole,
  type MotionClip,
  type MotionPose,
  type MotionProject,
} from "./core";
const frame = (
  t: number,
  angles: MotionPose["angles"] = {},
  root = { x: 0, y: 0.12 },
  feet: MotionPose["feet"] = { front: { x: 0.12, y: 0 }, rear: { x: -0.12, y: 0 } },
  contacts: MotionPose["contacts"] = ["front", "rear"],
): MotionPose => ({ t, angles, root, feet, contacts });
const clip = (
  id: string,
  name: string,
  duration: number,
  loop: boolean,
  frames: MotionPose[],
  events: MotionClip["events"] = [],
  stride = 0,
): MotionClip => ({
  id,
  name,
  duration,
  loop,
  frames,
  events,
  stride,
  family: "biped-side-v1",
  source: "Authored Sprite Tools motion template",
  license: "CC0-1.0",
});
function gait(id: string, run: boolean) {
  const frames = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8,
      s = Math.sin(t * Math.PI * 2),
      amp = run ? 0.34 : 0.22;
    const foot = (p: number) => ({
      x: p < 0.5 ? amp * (1 - p * 4) : -amp + amp * 4 * (p - 0.5),
      y: p < 0.5 ? 0 : -(run ? 0.3 : 0.18) * Math.sin((p - 0.5) * Math.PI * 2),
    });
    return frame(
      t,
      {
        torso: run ? 13 : 3,
        head: run ? -9 : -2,
        "front-arm": -s * (run ? 42 : 25),
        "front-forearm": run ? -60 : -18,
        "rear-arm": s * (run ? 42 : 25),
        "rear-forearm": run ? -60 : -18,
        tail: -s * 9,
        cape: s * 7,
      },
      { x: 0, y: (run ? 0.2 : 0.12) + Math.cos(t * Math.PI * 4) * 0.025 },
      { front: foot(t % 1), rear: foot((t + 0.5) % 1) },
      t % 1 < 0.5 ? ["front"] : ["rear"],
    );
  });
  return clip(
    id,
    run ? "Run" : "Walk",
    run ? 0.65 : 1,
    true,
    frames,
    [
      { t: 0, name: "front-contact" },
      { t: 0.5, name: "rear-contact" },
    ],
    run ? 1.36 : 0.88,
  );
}
export function starterClips(): MotionClip[] {
  return [
    clip("idle", "Breathe", 2.4, true, [
      frame(0),
      frame(0.5, { torso: -1, head: 1, cape: 2 }, { x: 0, y: 0.1 }),
      frame(1),
    ]),
    gait("walk", false),
    gait("run", true),
    clip(
      "jump",
      "Jump",
      0.95,
      false,
      [
        frame(0),
        frame(0.17, { torso: 14 }, { x: 0, y: 0.28 }),
        frame(
          0.32,
          {
            torso: -6,
            "front-arm": -130,
            "rear-arm": -130,
            "front-thigh": -25,
            "front-shin": 65,
            "rear-thigh": 22,
            "rear-shin": 50,
          },
          { x: 0, y: -0.55 },
          {},
          [],
        ),
        frame(
          0.55,
          {
            torso: 3,
            "front-arm": -100,
            "rear-arm": -90,
            "front-thigh": -48,
            "front-shin": 90,
            "rear-thigh": 30,
            "rear-shin": 65,
          },
          { x: 0, y: -0.9 },
          {},
          [],
        ),
        frame(0.78, { "front-thigh": -10, "front-shin": 12 }, { x: 0, y: -0.3 }, {}, []),
        frame(0.9, { torso: 10 }, { x: 0, y: 0.28 }),
        frame(1),
      ],
      [
        { t: 0.23, name: "takeoff" },
        { t: 0.88, name: "land" },
      ],
    ),
    clip(
      "stab",
      "Short stab",
      0.65,
      false,
      [
        frame(0),
        frame(0.25, { torso: -12, "front-arm": 28, "front-forearm": -100, "rear-arm": -25 }),
        frame(
          0.38,
          { torso: 18, head: -10, "front-arm": -105, "front-forearm": 0, "rear-arm": 55 },
          { x: 0.04, y: 0.16 },
        ),
        frame(0.55, { torso: 15, "front-arm": -98, "front-forearm": -5 }),
        frame(1),
      ],
      [
        { t: 0.25, name: "anticipation-end" },
        { t: 0.38, name: "hit-start" },
        { t: 0.55, name: "hit-end" },
        { t: 0.65, name: "can-interrupt" },
      ],
    ),
    clip(
      "sweep",
      "Wide swing",
      0.85,
      false,
      [
        frame(0),
        frame(
          0.28,
          { torso: -18, "front-arm": -140, "front-forearm": -70, "rear-arm": 28 },
          { x: -0.03, y: 0.22 },
        ),
        frame(
          0.43,
          { torso: 24, "front-arm": -85, "front-forearm": -8, "rear-arm": 65 },
          { x: 0.04, y: 0.2 },
        ),
        frame(0.62, { torso: 30, "front-arm": -5, "front-forearm": -25, "rear-arm": 50 }),
        frame(1),
      ],
      [
        { t: 0.28, name: "anticipation-end" },
        { t: 0.4, name: "hit-start" },
        { t: 0.6, name: "hit-end" },
      ],
    ),
  ];
}
export function newMotionProject(plan: CharacterPlan): MotionProject {
  return {
    format: "sprite-tools-motion",
    version: 1,
    clips: starterClips(),
    binding: autoBind(plan),
    settings: {
      speed: 0,
      rate: 1,
      footTargets: true,
      actionWeight: 1,
      actionMask: "full",
      mode: "locomotion",
      selected: "walk",
      action: "stab",
      fps: 12,
      padding: 64,
    },
  };
}

/** Deliberately simple motion mannequins: no generated artwork or paid dependency. */
export function motionMannequin(profile: "balanced" | "compact" | "long-legged" = "balanced") {
  const hip = profile === "compact" ? 320 : profile === "long-legged" ? 248 : 285;
  const shoulder = hip - (profile === "compact" ? 85 : 112),
    ground = 456,
    knee = (hip + ground) / 2;
  const joints: Record<JointRole, { a: [number, number]; b: [number, number]; width: number }> = {
    torso: { a: [256, hip], b: [256, shoulder], width: 54 },
    head: { a: [256, shoulder], b: [256, shoulder - 55], width: 48 },
    "front-arm": { a: [270, shoulder + 8], b: [282, shoulder + 65], width: 20 },
    "front-forearm": { a: [282, shoulder + 65], b: [306, shoulder + 115], width: 17 },
    "front-hand": { a: [306, shoulder + 115], b: [322, shoulder + 115], width: 20 },
    "rear-arm": { a: [242, shoulder + 8], b: [228, shoulder + 65], width: 20 },
    "rear-forearm": { a: [228, shoulder + 65], b: [220, shoulder + 115], width: 17 },
    "rear-hand": { a: [220, shoulder + 115], b: [236, shoulder + 115], width: 20 },
    "front-thigh": { a: [266, hip], b: [287, knee], width: 29 },
    "front-shin": { a: [287, knee], b: [266, ground], width: 23 },
    "front-foot": { a: [266, ground], b: [298, ground], width: 17 },
    "rear-thigh": { a: [246, hip], b: [258, knee], width: 29 },
    "rear-shin": { a: [258, knee], b: [246, ground], width: 23 },
    "rear-foot": { a: [246, ground], b: [278, ground], width: 17 },
    weapon: { a: [319, shoulder + 115], b: [388, shoulder + 115], width: 4 },
    tail: { a: [244, hip], b: [180, hip + 50], width: 9 },
    cape: { a: [247, shoulder], b: [216, hip - 5], width: 28 },
  };
  const order: JointRole[] = [
    "rear-arm",
    "rear-forearm",
    "rear-hand",
    "rear-thigh",
    "rear-shin",
    "rear-foot",
    "torso",
    "head",
    "front-thigh",
    "front-shin",
    "front-foot",
    "front-arm",
    "front-forearm",
    "front-hand",
    "weapon",
  ];
  const polygons = Object.fromEntries(
    order.map((r) => {
      const { a, b, width } = joints[r],
        angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const points = [b, a].flatMap((center, end) =>
        Array.from({ length: 9 }, (_, i) => {
          const t = angle - Math.PI / 2 + end * Math.PI + (i * Math.PI) / 8;
          return {
            x: center[0] + (Math.cos(t) * width) / 2,
            y: center[1] + (Math.sin(t) * width) / 2,
          };
        }),
      );
      return [r, points];
    }),
  );
  const images = order.map((r) => {
    const im = pixels(512, 512),
      polygon = polygons[r];
    const color =
      r === "weapon"
        ? [221, 198, 143]
        : r.startsWith("rear")
          ? [90, 111, 113]
          : r === "torso"
            ? [65, 135, 130]
            : [175, 204, 197];
    const x0 = Math.floor(Math.min(...polygon.map((p) => p.x))),
      x1 = Math.ceil(Math.max(...polygon.map((p) => p.x)));
    const y0 = Math.floor(Math.min(...polygon.map((p) => p.y))),
      y1 = Math.ceil(Math.max(...polygon.map((p) => p.y)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (insidePolygon(x + 0.5, y + 0.5, polygon))
          im.data.set([...color, 255], (y * 512 + x) * 4);
    return im;
  });
  const parts: CharacterPart[] = order.map((r) => {
    const { a, b } = joints[r];
    return {
      id: r,
      name: r.replaceAll("-", " "),
      parent: ROLE_PARENT[r] ?? null,
      pivot: { x: a[0], y: a[1] },
      tip: { x: b[0], y: b[1] },
      polygon: polygons[r],
      description: "Authored motion mannequin segment",
    };
  });
  const plan: CharacterPlan = {
    version: 1,
    width: 512,
    height: 512,
    origin: { x: 256, y: 465 },
    parts,
    notes: ["Motion mannequin. Import a Character Layers project to animate your own artwork."],
  };
  // Full segment artwork is available behind every overlap.
  const completions = Object.fromEntries(order.map((r, i) => [r, images[i]]));
  return { plan, source: composite(images), completions };
}
