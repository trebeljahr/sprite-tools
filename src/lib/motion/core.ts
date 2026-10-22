import { z } from "zod";
import { poseTransforms, type Matrix } from "../character/core";
import type { CharacterPlan, Point } from "../character/types";

export const ROLES = [
  "torso",
  "head",
  "front-arm",
  "front-forearm",
  "front-hand",
  "rear-arm",
  "rear-forearm",
  "rear-hand",
  "front-thigh",
  "front-shin",
  "front-foot",
  "rear-thigh",
  "rear-shin",
  "rear-foot",
  "tail",
  "cape",
  "weapon",
] as const;
export type JointRole = (typeof ROLES)[number];
export const ROLE_PARENT: Partial<Record<JointRole, JointRole>> = {
  head: "torso",
  "front-arm": "torso",
  "front-forearm": "front-arm",
  "front-hand": "front-forearm",
  "rear-arm": "torso",
  "rear-forearm": "rear-arm",
  "rear-hand": "rear-forearm",
  "front-thigh": "torso",
  "front-shin": "front-thigh",
  "front-foot": "front-shin",
  "rear-thigh": "torso",
  "rear-shin": "rear-thigh",
  "rear-foot": "rear-shin",
  tail: "torso",
  cape: "torso",
  weapon: "front-hand",
};
const AXIS: Record<JointRole, number> = {
  torso: -90,
  head: -90,
  "front-arm": 90,
  "front-forearm": 90,
  "front-hand": 90,
  "rear-arm": 90,
  "rear-forearm": 90,
  "rear-hand": 90,
  "front-thigh": 90,
  "front-shin": 90,
  "front-foot": 0,
  "rear-thigh": 90,
  "rear-shin": 90,
  "rear-foot": 0,
  tail: 180,
  cape: 90,
  weapon: 0,
};
const num = z.number().finite();
const xy = z.object({ x: num.min(-4).max(4), y: num.min(-4).max(4) }).strict();
const rotations = z.record(z.enum(ROLES), num.min(-180).max(180));
const frameSchema = z
  .object({
    t: num.min(0).max(1),
    angles: rotations,
    root: xy,
    feet: z.object({ front: xy.optional(), rear: xy.optional() }).strict(),
    contacts: z.array(z.enum(["front", "rear"])).max(2),
  })
  .strict();
export const clipSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(80),
    family: z.literal("biped-side-v1"),
    duration: num.min(0.15).max(10),
    loop: z.boolean(),
    // Stride is measured in leg lengths per cycle; root is a separate visual offset.
    stride: num.min(0).max(8),
    frames: z.array(frameSchema).min(2).max(128),
    events: z
      .array(z.object({ t: num.min(0).max(1), name: z.string().min(1).max(60) }).strict())
      .max(32),
    source: z.string().min(1).max(300),
    license: z.string().min(1).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.frames[0].t !== 0 ||
      v.frames.at(-1)!.t !== 1 ||
      v.frames.some((f, i) => i > 0 && f.t <= v.frames[i - 1].t)
    )
      ctx.addIssue({ code: "custom", message: "Keyframes must increase from 0 to 1." });
  });
export type MotionClip = z.infer<typeof clipSchema>;
export type MotionPose = z.infer<typeof frameSchema>;
export type Binding = Partial<Record<JointRole, { part: string; offset: number }>>;
export const projectSchema = z
  .object({
    format: z.literal("sprite-tools-motion"),
    version: z.literal(1),
    clips: z.array(clipSchema).min(1).max(24),
    binding: z.record(
      z.enum(ROLES),
      z
        .object({
          part: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
          offset: num.min(-180).max(180),
        })
        .strict(),
    ),
    settings: z
      .object({
        speed: num.min(0).max(1),
        rate: num.min(0.1).max(2),
        footTargets: z.boolean(),
        actionWeight: num.min(0).max(1),
        actionMask: z.enum(["full", "upper"]),
        mode: z.enum(["locomotion", "clip"]),
        selected: z.string().max(64),
        action: z.string().max(64),
        fps: num.int().min(4).max(30),
        padding: num.int().min(0).max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.clips.map((c) => c.id)).size !== v.clips.length)
      ctx.addIssue({ code: "custom", message: "Motion ids must be unique." });
    const ids = new Set(v.clips.map((c) => c.id));
    if (
      !ids.has(v.settings.selected) ||
      !ids.has(v.settings.action) ||
      (v.settings.mode === "locomotion" && (!ids.has("walk") || !ids.has("run")))
    )
      ctx.addIssue({ code: "custom", message: "Settings refer to missing motion clips." });
    const parts = Object.values(v.binding).map((b) => b!.part);
    if (new Set(parts).size !== parts.length)
      ctx.addIssue({ code: "custom", message: "A part can have only one joint role." });
  });
export type MotionProject = z.infer<typeof projectSchema>;
export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const wrapAngle = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
const angleLerp = (a: number, b: number, w: number) => a + wrapAngle(b - a) * w;
const pointLerp = (a: Point, b: Point, w: number) => ({
  x: lerp(a.x, b.x, w),
  y: lerp(a.y, b.y, w),
});

export function blendPoses(
  a: MotionPose,
  b: MotionPose,
  weight: number,
  mask: "full" | "upper" = "full",
): MotionPose {
  const w = clamp(weight),
    angles = { ...a.angles };
  for (const role of ROLES)
    if (
      mask === "full" ||
      [
        "torso",
        "head",
        "front-arm",
        "front-forearm",
        "front-hand",
        "rear-arm",
        "rear-forearm",
        "rear-hand",
        "weapon",
        "cape",
      ].includes(role)
    )
      angles[role] = angleLerp(a.angles[role] ?? 0, b.angles[role] ?? 0, w);
  const feet: MotionPose["feet"] = {};
  for (const side of ["front", "rear"] as const) {
    const p = a.feet[side],
      q = b.feet[side];
    feet[side] = mask === "upper" ? p : p && q ? pointLerp(p, q, w) : w < 0.5 ? p : q;
  }
  return {
    t: a.t,
    angles,
    root: mask === "upper" ? a.root : pointLerp(a.root, b.root, w),
    feet,
    contacts: mask === "upper" || w < 0.5 ? a.contacts : b.contacts,
  };
}
export function sampleClip(clip: MotionClip, phase: number): MotionPose {
  const cycle = phase % 1;
  const t = clip.loop && (phase < 0 || phase > 1) ? (cycle < 0 ? cycle + 1 : cycle) : clamp(phase);
  const i = clip.frames.findIndex((f, i) => i > 0 && f.t >= t);
  const hi = i < 0 ? clip.frames.length - 1 : i,
    lo = Math.max(0, hi - 1),
    a = clip.frames[lo],
    b = clip.frames[hi];
  const pose = blendPoses(a, b, a === b ? 0 : (t - a.t) / (b.t - a.t));
  return { ...pose, t, contacts: t === b.t ? b.contacts : a.contacts };
}
export function evaluateMotion(project: MotionProject, phase: number, actionPhase?: number) {
  const s = project.settings;
  const find = (id: string) => project.clips.find((c) => c.id === id)!;
  const a = s.mode === "clip" ? find(s.selected) : find("walk"),
    b = s.mode === "clip" ? a : find("run");
  const weight = s.mode === "clip" ? 0 : s.speed;
  let pose = blendPoses(sampleClip(a, phase), sampleClip(b, phase), weight);
  if (actionPhase !== undefined) {
    // Fade pose influence, never whole character images. The base gait keeps its phase.
    const edge = clamp(Math.min(actionPhase, 1 - actionPhase) / 0.12);
    const envelope = edge * edge * (3 - 2 * edge);
    pose = blendPoses(
      pose,
      sampleClip(find(s.action), actionPhase),
      s.actionWeight * envelope,
      s.actionMask,
    );
  }
  return {
    pose,
    duration: lerp(a.duration, b.duration, weight) / s.rate,
    stride: lerp(a.stride, b.stride, weight),
  };
}
export const transformPoint = (m: Matrix, p: Point): Point => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
const direction = (a: Point, b: Point) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
export function legUnit(plan: CharacterPlan, binding: Binding) {
  const p = (r: JointRole) => plan.parts.find((p) => p.id === binding[r]?.part)?.pivot;
  const hip = p("front-thigh"),
    knee = p("front-shin"),
    ankle = p("front-foot");
  return hip && knee && ankle
    ? Math.max(1, length(hip, knee) + length(knee, ankle))
    : plan.height * 0.35;
}
export function autoBind(plan: CharacterPlan): Binding {
  const aliases: Record<string, string[]> = {
    torso: ["torso", "body", "coat-torso"],
    head: ["head"],
    "front-arm": ["upper-arm", "sword-upper-arm", "front-arm"],
    "front-forearm": ["forearm", "sword-forearm", "front-forearm"],
    "front-hand": ["hand", "sword-hand", "front-hand"],
    "rear-arm": ["rear-arm", "rear-upper-arm", "free-upper-arm"],
    "rear-forearm": ["rear-forearm", "free-forearm"],
    "rear-hand": ["rear-hand", "free-hand"],
    "front-thigh": ["front-thigh", "front-leg"],
    "front-shin": ["front-shin"],
    "front-foot": ["front-foot"],
    "rear-thigh": ["rear-thigh", "rear-leg"],
    "rear-shin": ["rear-shin"],
    "rear-foot": ["rear-foot"],
    tail: ["tail"],
    cape: ["cape"],
    weapon: ["weapon", "sword", "needle"],
  };
  const out: Binding = {},
    used = new Set<string>();
  for (const r of ROLES) {
    const p = plan.parts.find((p) => aliases[r].includes(p.id) && !used.has(p.id));
    if (p) {
      out[r] = { part: p.id, offset: 0 };
      used.add(p.id);
    }
  }
  return out;
}

/** Shared neutral axes adapt a local-delta motion to each character's source pose. */
export function retargetPose(
  plan: CharacterPlan,
  binding: Binding,
  pose: MotionPose,
  useFootTargets = true,
) {
  const angles: Record<string, number> = {},
    parts = new Map(plan.parts.map((p) => [p.id, p])),
    warnings: string[] = [];
  const byPart = new Map(Object.entries(binding).map(([r, b]) => [b!.part, r as JointRole]));
  const worldDelta = (r: JointRole): number =>
    (pose.angles[r] ?? 0) + (ROLE_PARENT[r] ? worldDelta(ROLE_PARENT[r]!) : 0);
  const totals: Record<string, number> = {};
  const visit = (id: string): number => {
    if (totals[id] !== undefined) return totals[id];
    const p = parts.get(id)!,
      parent = p.parent ? visit(p.parent) : 0,
      role = byPart.get(id);
    // Weapons retain their original grip relationship to the hand unless explicitly keyed.
    angles[id] =
      role && role !== "weapon"
        ? wrapAngle(
            AXIS[role] +
              worldDelta(role) +
              (binding[role]?.offset ?? 0) -
              direction(p.pivot, p.tip) -
              parent,
          )
        : role === "weapon"
          ? (pose.angles.weapon ?? 0) + (binding.weapon?.offset ?? 0)
          : 0;
    totals[id] = parent + angles[id];
    return totals[id];
  };
  for (const p of plan.parts) visit(p.id);
  const unit = legUnit(plan, binding),
    root = { x: pose.root.x * unit, y: pose.root.y * unit };
  if (useFootTargets)
    for (const side of ["front", "rear"] as const) {
      const target = pose.feet[side];
      if (!target) continue;
      const thigh = parts.get(binding[`${side}-thigh`]?.part ?? ""),
        shin = parts.get(binding[`${side}-shin`]?.part ?? ""),
        foot = parts.get(binding[`${side}-foot`]?.part ?? "");
      if (!thigh || !shin || !foot || shin.parent !== thigh.id || foot.parent !== shin.id) {
        warnings.push(`${side} foot target needs a direct thigh → shin → foot chain.`);
        continue;
      }
      const matrices = poseTransforms(plan, angles);
      const hip = transformPoint(matrices[thigh.id], thigh.pivot),
        l1 = length(thigh.pivot, shin.pivot),
        l2 = length(shin.pivot, foot.pivot);
      if (l1 < 1 || l2 < 1) {
        warnings.push(`${side} leg has a zero-length segment.`);
        continue;
      }
      const goal = {
        x: plan.origin.x + target.x * unit - root.x,
        y: foot.pivot.y + target.y * unit - root.y,
      };
      const raw = length(hip, goal),
        d = clamp(raw, Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001);
      if (Math.abs(raw - d) > 0.5) warnings.push(`${side} foot target is beyond this leg's reach.`);
      const dir = Math.atan2(goal.y - hip.y, goal.x - hip.x),
        bend = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)),
        upper = dir - bend;
      const knee = { x: hip.x + Math.cos(upper) * l1, y: hip.y + Math.sin(upper) * l1 };
      const actualGoal = { x: hip.x + Math.cos(dir) * d, y: hip.y + Math.sin(dir) * d };
      const lower = Math.atan2(actualGoal.y - knee.y, actualGoal.x - knee.x);
      const parentMatrix = thigh.parent ? matrices[thigh.parent] : [1, 0, 0, 1, 0, 0];
      const parentAngle = (Math.atan2(parentMatrix[1], parentMatrix[0]) * 180) / Math.PI;
      const thighWorld = (upper * 180) / Math.PI - direction(thigh.pivot, shin.pivot);
      angles[thigh.id] = wrapAngle(thighWorld - parentAngle);
      const shinWorld = (lower * 180) / Math.PI - direction(shin.pivot, foot.pivot);
      angles[shin.id] = wrapAngle(shinWorld - thighWorld);
      angles[foot.id] = wrapAngle(
        (binding[`${side}-foot`]?.offset ?? 0) - direction(foot.pivot, foot.tip) - shinWorld,
      );
    }
  return { angles, root, unit, warnings: [...new Set(warnings)] };
}

export function exportSamples(project: MotionProject, action = false) {
  const duration = action
    ? project.clips.find((c) => c.id === project.settings.action)!.duration / project.settings.rate
    : evaluateMotion(project, 0).duration;
  const loop =
    !action &&
    (project.settings.mode === "locomotion" ||
      project.clips.find((c) => c.id === project.settings.selected)!.loop);
  const count = Math.max(2, Math.ceil(duration * project.settings.fps));
  return {
    duration,
    loop,
    phases: Array.from({ length: count }, (_, i) => (loop ? i / count : i / (count - 1))),
  };
}
