import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { ROLES } from "../src/lib/motion/core";
import { motionMannequin, newMotionProject } from "../src/lib/motion/presets";
import {
  decodeMotionProject,
  encodeMotionProject,
  motionEvents,
  MOTION_JSON_MAX_BYTES,
} from "../src/lib/motion/project";
import { importMotionProject } from "../src/lib/motion/browser";
import { checkCharacterZip, readCharacterZipFile } from "../src/lib/character/zip-guard";

describe("motion project persistence and events", () => {
  it("round-trips a large valid motion library through the ZIP byte limits", async () => {
    const project = newMotionProject(motionMannequin().plan);
    const original = project.clips;
    project.clips = Array.from({ length: 24 }, (_, i) => ({
      ...original[i % original.length],
      id: i < original.length ? original[i].id : `motion-${i}`,
      frames: Array.from({ length: 128 }, (_, index) => ({
        ...original[0].frames[0],
        t: index / 127,
        angles: Object.fromEntries(ROLES.map((role) => [role, 123.123456789])),
      })),
    }));
    const bytes = encodeMotionProject(project);
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const zip = new JSZip().file("motion.json", bytes);
    const archive = await zip.generateAsync({ type: "uint8array" });
    checkCharacterZip(archive);
    const reopened = await JSZip.loadAsync(archive);
    const data = await readCharacterZipFile(reopened.file("motion.json"), MOTION_JSON_MAX_BYTES);
    expect(decodeMotionProject(data)).toEqual(project);
  });
  it("rejects oversized files before allocating their contents", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      importMotionProject({ size: 64 * 1024 * 1024 + 1, arrayBuffer } as unknown as File),
    ).rejects.toThrow("64 MB");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(() => decodeMotionProject(new Uint8Array(MOTION_JSON_MAX_BYTES + 1))).toThrow("8 MB");
  });
  it("exports events from the dominant gait or the selected action", () => {
    const project = newMotionProject(motionMannequin().plan);
    const events = (id: string) => project.clips.find((clip) => clip.id === id)!.events;
    project.clips.find((clip) => clip.id === "run")!.events = [{ t: 0.3, name: "run-only" }];
    project.settings.speed = 0.49;
    expect(motionEvents(project)).toEqual(events("walk"));
    project.settings.speed = 0.5;
    expect(motionEvents(project)).toEqual(events("run"));
    project.settings.speed = 1;
    expect(motionEvents(project)).toEqual(events("run"));
    project.settings.mode = "clip";
    project.settings.selected = "jump";
    expect(motionEvents(project)).toEqual(events("jump"));
    expect(motionEvents(project, true)).toEqual(events(project.settings.action));
  });
});
