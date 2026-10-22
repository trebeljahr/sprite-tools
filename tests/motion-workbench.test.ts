import { describe, expect, it } from "vitest";
import {
  blendPoses,
  clipSchema,
  evaluateMotion,
  exportSamples,
  legUnit,
  projectSchema,
  retargetPose,
  sampleClip,
  transformPoint,
} from "../src/lib/motion/core";
import { motionMannequin, newMotionProject, starterClips } from "../src/lib/motion/presets";
import { poseTransforms, prepareCharacter } from "../src/lib/character/core";
import { validatePlan } from "../src/lib/character/types";

import { motionStudy } from "../src/lib/motion/study";

describe("reusable motion authoring", () => {
  it("supplies agent-readable motion and retargeted controls", () => {
    const plan = motionMannequin().plan;
    const study = motionStudy({ template: "stab", character_plan: plan, samples: 6 });
    expect(study.frames).toHaveLength(6);
    expect(study.frames.at(-1)!.phase).toBe(1);
    expect(study.frames[0].target?.joints.some((j) => j.id === "weapon")).toBe(true);
    expect(clipSchema.parse(study.clip).license).toBe("CC0-1.0");
    expect(() => motionStudy({ samples: 100 })).toThrow();
  });
  it("validates all templates and target proportions", () => {
    for (const profile of ["balanced", "compact", "long-legged"] as const) {
      const session = motionMannequin(profile);
      expect(validatePlan(session.plan)).toEqual(session.plan);
      const bundle = prepareCharacter(session.source, session.plan, session.completions);
      expect(bundle.report.unassignedPixels).toBe(0);
      expect(bundle.layers.every((l) => l.filledPixels === l.hiddenPixels)).toBe(true);
      expect(projectSchema.parse(newMotionProject(session.plan)).clips).toHaveLength(6);
    }
    for (const clip of starterClips()) expect(clipSchema.parse(clip)).toEqual(clip);
  });
  it("rejects duplicate times, missing endpoints and unsupported families", () => {
    const c = starterClips()[1];
    expect(() => clipSchema.parse({ ...c, frames: [...c.frames, c.frames[1]] })).toThrow();
    expect(() => clipSchema.parse({ ...c, frames: c.frames.slice(1) })).toThrow();
    expect(() => clipSchema.parse({ ...c, family: "quadruped" })).toThrow();
    expect(() => clipSchema.parse({ ...c, stride: Infinity })).toThrow();
  });
  it("rejects missing clips and duplicate part assignments in a project", () => {
    const p = newMotionProject(motionMannequin().plan);
    expect(() =>
      projectSchema.parse({ ...p, clips: p.clips.filter((c) => c.id !== "walk") }),
    ).toThrow();
    expect(() =>
      projectSchema.parse({
        ...p,
        binding: { torso: { part: "head", offset: 0 }, head: { part: "head", offset: 0 } },
      }),
    ).toThrow();
    expect(() => projectSchema.parse({ ...p, clips: [...p.clips, p.clips[0]] })).toThrow();
  });
  it("samples cyclic motion and exposes both endpoint poses for editing", () => {
    const walk = starterClips()[1];
    expect(sampleClip(walk, 0.25).root).toEqual(sampleClip(walk, 1.25).root);
    const changed = {
      ...walk,
      frames: walk.frames.map((f, i) =>
        i === walk.frames.length - 1 ? { ...f, angles: { torso: 20 } } : f,
      ),
    };
    expect(sampleClip(changed, 1).angles.torso).toBe(20);
    const jump = starterClips().find((c) => c.id === "jump")!;
    expect(sampleClip(jump, 3).root).toEqual(jump.frames.at(-1)!.root);
  });
  it("changes contacts at exact keys and preserves in-range sample times", () => {
    const source = starterClips()[0],
      frame = source.frames[0],
      clip = clipSchema.parse({
        ...source,
        frames: [
          { ...frame, t: 0, contacts: ["front"] },
          { ...frame, t: 0.3, contacts: ["rear"] },
          { ...frame, t: 0.5, contacts: [] },
          { ...frame, t: 1, contacts: ["front", "rear"] },
        ],
      });
    expect(sampleClip(clip, 0.3).t).toBe(0.3);
    expect(sampleClip(clip, 0.3 - 0.000001).contacts).toEqual(["front"]);
    expect(sampleClip(clip, 0.3).contacts).toEqual(["rear"]);
    expect(sampleClip(clip, 0.3 + 0.000001).contacts).toEqual(["rear"]);
    expect(sampleClip(clip, 0.5 - 0.000001).contacts).toEqual(["rear"]);
    expect(sampleClip(clip, 0.5).contacts).toEqual([]);
    expect(sampleClip(clip, 1 - 0.000001).contacts).toEqual([]);
    expect(sampleClip(clip, 1).contacts).toEqual(["front", "rear"]);
    expect(sampleClip(clip, 1.5).contacts).toEqual([]);
    expect(sampleClip(clip, -0.5).contacts).toEqual([]);
    expect(sampleClip(clip, 2).contacts).toEqual(["front"]);
    expect(sampleClip({ ...clip, loop: false }, 3).contacts).toEqual(["front", "rear"]);
    expect(sampleClip(starterClips()[1], 0.5).contacts).toEqual(["rear"]);
  });
  it("interpolates rotations across the short arc, without mutating source", () => {
    const c = starterClips()[0],
      a = { ...c.frames[0], angles: { torso: 170 } },
      b = { ...a, angles: { torso: -170 } };
    expect(blendPoses(a, b, 0.5).angles.torso).toBe(180);
    expect(a.angles.torso).toBe(170);
  });
  it("keeps locomotion root and feet under an upper-body action", () => {
    const p = newMotionProject(motionMannequin().plan);
    p.settings.actionMask = "upper";
    const base = evaluateMotion(p, 0.25).pose,
      mixed = evaluateMotion(p, 0.25, 0.38).pose;
    expect(mixed.feet).toEqual(base.feet);
    expect(mixed.root).toEqual(base.root);
    expect(mixed.angles["front-arm"]).not.toBe(base.angles["front-arm"]);
    expect(evaluateMotion(p, 0.25, 0).pose.root).toEqual(base.root);
    expect(evaluateMotion(p, 0.25, 1).pose.angles["front-arm"]).toBe(base.angles["front-arm"]);
  });
  it("uses full-body action footwork and keeps rate separate from blend weight", () => {
    const p = newMotionProject(motionMannequin().plan),
      base = evaluateMotion(p, 0.25);
    expect(evaluateMotion(p, 0.25, 0.38).pose.feet).not.toEqual(base.pose.feet);
    p.settings.rate = 2;
    expect(evaluateMotion(p, 0.25).duration).toBe(base.duration / 2);
    expect(evaluateMotion(p, 0.25).pose).toEqual(base.pose);
  });
  it("solves reachable planted targets on all three proportions and blended gaits", () => {
    for (const profile of ["balanced", "compact", "long-legged"] as const)
      for (const speed of [0, 0.5, 1]) {
        const { plan } = motionMannequin(profile),
          p = newMotionProject(plan);
        p.settings.speed = speed;
        for (const phase of [0, 0.125, 0.25, 0.5, 0.75]) {
          const pose = evaluateMotion(p, phase).pose,
            r = retargetPose(plan, p.binding, pose),
            m = poseTransforms(plan, r.angles);
          for (const side of pose.contacts) {
            const foot = plan.parts.find((part) => part.id === p.binding[`${side}-foot`]?.part)!,
              target = pose.feet[side]!;
            const actual = transformPoint(m[foot.id], foot.pivot);
            expect(actual.y + r.root.y).toBeCloseTo(foot.pivot.y + target.y * r.unit, 4);
            expect(actual.x + r.root.x).toBeCloseTo(plan.origin.x + target.x * r.unit, 4);
          }
        }
      }
  });
  it("keeps weapon grip rigidly attached through arm motion", () => {
    const { plan } = motionMannequin(),
      p = newMotionProject(plan),
      pose = evaluateMotion(p, 0.3, 0.38).pose;
    const r = retargetPose(plan, p.binding, pose),
      m = poseTransforms(plan, r.angles),
      weapon = plan.parts.find((p) => p.id === "weapon")!;
    expect(m.weapon).toEqual(m[weapon.parent!]);
  });
  it("reports incompatible foot chains and unreachable targets without NaNs", () => {
    const { plan } = motionMannequin(),
      p = newMotionProject(plan),
      pose = evaluateMotion(p, 0).pose;
    const far = { ...pose, feet: { front: { x: 4, y: 0 } } };
    const result = retargetPose(plan, p.binding, far);
    expect(result.warnings.join(" ")).toContain("beyond");
    expect(Object.values(result.angles).every(Number.isFinite)).toBe(true);
    const changed = {
      ...plan,
      parts: plan.parts.map((p) => (p.id === "front-foot" ? { ...p, parent: "torso" } : p)),
    };
    expect(retargetPose(changed, p.binding, pose).warnings.join(" ")).toContain("direct thigh");
  });
  it("bakes unique loop phases and includes one-shot endpoints", () => {
    const p = newMotionProject(motionMannequin().plan);
    const loop = exportSamples(p);
    expect(loop.loop).toBe(true);
    expect(loop.phases.at(-1)).toBeLessThan(1);
    p.settings.mode = "clip";
    p.settings.selected = "jump";
    const one = exportSamples(p);
    expect(one.loop).toBe(false);
    expect(one.phases.at(-1)).toBe(1);
    expect(exportSamples(p, true).phases.at(-1)).toBe(1);
  });
  it("scales offsets by target leg length rather than source pixels", () => {
    const a = motionMannequin("compact").plan,
      b = motionMannequin("long-legged").plan,
      pa = newMotionProject(a),
      pb = newMotionProject(b);
    const pose = { ...sampleClip(pa.clips[0], 0), root: { x: 0.1, y: -0.2 } };
    expect(retargetPose(a, pa.binding, pose, false).root.x / legUnit(a, pa.binding)).toBeCloseTo(
      0.1,
    );
    expect(retargetPose(b, pb.binding, pose, false).root.x).toBeGreaterThan(
      retargetPose(a, pa.binding, pose, false).root.x,
    );
  });
});
