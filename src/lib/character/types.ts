import { z } from "zod";

export const MAX_CHARACTER_PIXELS = 4_194_304;
const point = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0) });
export const characterPartSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  parent: z.string().nullable(),
  pivot: point,
  tip: point,
  polygon: z.array(point).min(3).max(128),
  description: z.string().max(600).default(""),
});
export const characterPlanSchema = z
  .object({
    version: z.literal(1),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    origin: point,
    // Back to front. A later part owns visible pixels in overlapping polygons.
    parts: z.array(characterPartSchema).min(1).max(32),
    notes: z.array(z.string().max(500)).max(32).default([]),
  })
  .superRefine((p, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: "custom", message });
    if (p.width * p.height * p.parts.length > 32_000_000)
      error(
        "Too many layer pixels. Reduce canvas size or part count (32 million layer pixels maximum).",
      );
    if (p.width * p.height > MAX_CHARACTER_PIXELS) error("Character exceeds 4 megapixels.");
    const ids = new Set(p.parts.map((a) => a.id));
    if (
      ids.size !== p.parts.length ||
      ["unassigned", "constructor", "prototype"].some((id) => ids.has(id))
    )
      error("Part ids must be unique; unassigned, constructor and prototype are reserved.");
    const inside = (a: Point) => a.x <= p.width && a.y <= p.height;
    if (!inside(p.origin)) error("Origin is outside the canvas.");
    for (const part of p.parts) {
      if (![part.pivot, part.tip, ...part.polygon].every(inside))
        error(`${part.id}: coordinates outside the canvas.`);
      const seen = new Set([part.id]);
      let parent = part.parent;
      while (parent) {
        if (!ids.has(parent)) {
          error(`${part.id}: unknown parent.`);
          break;
        }
        if (seen.has(parent)) {
          error("Part hierarchy contains a cycle.");
          break;
        }
        seen.add(parent);
        parent = p.parts.find((a) => a.id === parent)?.parent ?? null;
      }
    }
  });
export type Point = z.infer<typeof point>;
export type CharacterPart = z.infer<typeof characterPartSchema>;
export type CharacterPlan = z.infer<typeof characterPlanSchema>;
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
export interface PreparedLayer {
  id: string;
  visible: Pixels;
  generated: Pixels;
  hiddenMask: Pixels;
  image: Pixels;
  visiblePixels: number;
  hiddenPixels: number;
  filledPixels: number;
  completion: "missing" | "imported" | "generated" | "none";
}
export interface CharacterBundle {
  plan: CharacterPlan;
  layers: PreparedLayer[];
  reconstruction: Pixels;
  report: { unassignedPixels: number; changedPixels: number; warnings: string[] };
}
export function validatePlan(input: unknown): CharacterPlan {
  const r = characterPlanSchema.safeParse(input);
  if (!r.success)
    throw new Error(`Invalid character plan: ${r.error.issues.map((a) => a.message).join(" ")}`);
  return r.data;
}
