import { z } from "zod";

export const roles = [
  "idle",
  "walk",
  "run",
  "jump",
  "roll",
  "attack1",
  "attack2",
  "attack3",
  "crouchDown",
  "crouch",
  "crouchUp",
  "crouchAttack",
  "lowAttack",
] as const;
export type Role = (typeof roles)[number];
const colour = z.object({
  saturation: z.number().min(0).max(2).default(1),
  contrast: z.number().min(0.5).max(1.5).default(1),
  brightness: z.number().min(0.5).max(1.5).default(1),
});
const span = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
const clip = z
  .object({
    sheet: z.string().min(1).max(2048),
    grid: z.object({
      cols: z.number().int().min(1).max(64),
      rows: z.number().int().min(1).max(64),
    }),
    count: z.number().int().min(1).max(1024),
    durations: z.array(z.number().min(8).max(10000)).min(1).max(1024),
    loop: z.boolean(),
    phase: z
      .object({
        active: span.optional(),
        anticipation: span.optional(),
        recovery: span.optional(),
        takeoff: z
          .object({ from: z.number().int().min(0), to: z.number().int().min(0) })
          .optional(),
        air: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
        land: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
      })
      .nullable()
      .optional(),
    colour: colour.optional(),
    locomotion: z
      .object({
        stridePixels: z.number().min(40).max(2000),
        phaseOffset: z.number().min(0).lt(1).default(0),
        groundOffsets: z.array(z.number().min(-100).max(100)).max(1024).optional(),
      })
      .optional(),
  })
  .passthrough();
const schema = z
  .object({
    version: z.literal(1),
    character: z.string().max(100).default("Sprite"),
    canvas: z.object({
      width: z.number().int().min(1).max(2048),
      height: z.number().int().min(1).max(2048),
    }),
    origin: z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) }),
    clips: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), clip),
    controller: z
      .object({
        bindings: z.record(z.enum(roles), z.string().nullable()).optional(),
        layerProject: z.string().max(2048).optional(),
        runSpeed: z.number().min(400).max(2400).optional(),
        runCycleMs: z.number().min(100).max(2000).optional(),
        labels: z.record(z.enum(roles), z.string().max(100)).optional(),
      })
      .optional(),
  })
  .passthrough();
export type AnimationSet = z.infer<typeof schema> & { bindings: Record<Role, string | null> };
export function validateAnimationSet(value: unknown): AnimationSet {
  const s = schema.parse(value),
    names = Object.keys(s.clips);
  if (!names.length || names.length > 32) throw Error("Use 1–32 animation clips.");
  if (s.origin.x > s.canvas.width || s.origin.y > s.canvas.height)
    throw Error("Origin is outside the sprite canvas.");
  let total = 0;
  for (const c of Object.values(s.clips)) {
    if (c.count > c.grid.cols * c.grid.rows || c.durations.length !== c.count)
      throw Error("Clip frame counts, grid and durations must agree.");
    if (c.locomotion?.groundOffsets && c.locomotion.groundOffsets.length !== c.count)
      throw Error("Ground offsets must match the clip frame count.");
    total += s.canvas.width * s.canvas.height * c.grid.cols * c.grid.rows;
    for (const p of Object.values(c.phase ?? {})) {
      if (!p) continue;
      const [a, b] = Array.isArray(p) ? p : [p.from, p.to];
      if (a > b || b >= c.count) throw Error("Animation phase is outside its clip.");
    }
  }
  if (total > 128_000_000) throw Error("Animation sheets exceed 128 million pixels in total.");
  const attacks = names.filter((n) => s.clips[n].phase?.active);
  const bindings = Object.fromEntries(
    roles.map((r, i) => [
      r,
      s.controller?.bindings?.[r] ??
        (r.startsWith("attack") ? (attacks[i - 5] ?? null) : names.includes(r) ? r : null),
    ]),
  ) as Record<Role, string | null>;
  // Explicit null means no authored clip, with a visibly labelled preview fallback.
  for (const r of roles)
    if (s.controller?.bindings && r in s.controller.bindings)
      bindings[r] = s.controller.bindings[r] ?? null;
  for (const n of Object.values(bindings))
    if (n && !s.clips[n]) throw Error("Controller binding references an unknown clip.");
  bindings.idle ??= names[0];
  return { ...s, bindings };
}
export function clipFor(set: AnimationSet, role: Role) {
  const id =
    set.bindings[role] ?? (role === "run" ? set.bindings.walk : null) ?? set.bindings.idle!;
  return { id, clip: set.clips[id], fallback: !set.bindings[role] };
}
export function roleDuration(set: AnimationSet, role: Role) {
  if (role === "roll" && !set.bindings.roll) return 0.5;
  const c = clipFor(set, role).clip;
  return (
    c.durations.reduce((a, b) => a + b, 0) / 1000 / (role === "run" && !set.bindings.run ? 1.65 : 1)
  );
}
export function frameAt(set: AnimationSet, role: Role, seconds: number, loop = true) {
  const { clip } = clipFor(set, role),
    duration = roleDuration(set, role);
  let ms =
    (loop ? seconds % duration : Math.min(seconds, duration - 0.000001)) *
    1000 *
    (role === "run" && !set.bindings.run ? 1.65 : 1);
  for (let i = 0; i < clip.count; i++) {
    if (ms < clip.durations[i]) return i;
    ms -= clip.durations[i];
  }
  return clip.count - 1;
}
