import { projectSchema, type MotionProject } from "./core";

export const MOTION_JSON_MAX_BYTES = 8 * 1024 * 1024;

export function encodeMotionProject(project: MotionProject): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(projectSchema.parse(project), null, 2));
  if (bytes.length > MOTION_JSON_MAX_BYTES) throw Error("Motion project JSON exceeds 8 MB.");
  return bytes;
}

export function decodeMotionProject(bytes: Uint8Array): MotionProject {
  if (bytes.length > MOTION_JSON_MAX_BYTES) throw Error("Motion project JSON exceeds 8 MB.");
  return projectSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Discrete events follow the dominant gait, matching contact-marker blending. */
export function motionEvents(project: MotionProject, action = false) {
  const s = project.settings;
  const id = action ? s.action : s.mode === "clip" ? s.selected : s.speed < 0.5 ? "walk" : "run";
  return project.clips.find((clip) => clip.id === id)!.events;
}
