import { z } from "zod";
import { validatePlan, type CharacterPlan } from "../character/types";
import { poseTransforms } from "../character/core";
import { autoBind, clipSchema, retargetPose, sampleClip, transformPoint } from "./core";
import { starterClips } from "./presets";
export const studySchema = z
  .object({
    template: z.enum(["idle", "walk", "run", "jump", "stab", "sweep"]).default("walk"),
    clip: clipSchema.optional(),
    character_plan: z.record(z.unknown()).optional(),
    samples: z.number().int().min(2).max(64).default(12),
  })
  .strict();
/** Free, deterministic pose controls for agents and command-line asset workflows. */
export function motionStudy(input: z.input<typeof studySchema>) {
  const value = studySchema.parse(input),
    clip = value.clip ?? starterClips().find((c) => c.id === value.template)!;
  const plan: CharacterPlan | undefined = value.character_plan
    ? validatePlan(value.character_plan)
    : undefined;
  const binding = plan ? autoBind(plan) : undefined;
  const frames = Array.from({ length: value.samples }, (_, i) => {
    const phase = clip.loop ? i / value.samples : i / (value.samples - 1),
      pose = sampleClip(clip, phase);
    if (!plan || !binding) return { phase, pose };
    const target = retargetPose(plan, binding, pose),
      matrices = poseTransforms(plan, target.angles);
    return {
      phase,
      pose,
      target: {
        ...target,
        joints: plan.parts.map((p) => {
          const pivot = transformPoint(matrices[p.id], p.pivot),
            tip = transformPoint(matrices[p.id], p.tip);
          return {
            id: p.id,
            parent: p.parent,
            pivot: { x: pivot.x + target.root.x, y: pivot.y + target.root.y },
            tip: { x: tip.x + target.root.x, y: tip.y + target.root.y },
          };
        }),
      },
    };
  });
  return {
    format: "sprite-tools-motion-study",
    version: 1,
    clip,
    binding,
    frames,
    units: "pose offsets: leg lengths; target coordinates: source pixels; angles: local degrees",
    note: "Pose controls only. Import clip into Motion Workbench to edit, render artwork and export sheets. Review joint mapping and reach warnings.",
  };
}
