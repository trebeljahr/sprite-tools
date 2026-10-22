import JSZip from "jszip";
import {
  croppedCanvas,
  exportCharacterZip,
  importCharacterZip,
  type CharacterSession,
} from "../character/browser";
import type { CharacterBundle } from "../character/types";
import { checkCharacterZip, readCharacterZipFile } from "../character/zip-guard";
import { poseTransforms } from "../character/core";
import {
  evaluateMotion,
  exportSamples,
  projectSchema,
  retargetPose,
  transformPoint,
  type MotionPose,
  type MotionProject,
} from "./core";

import {
  decodeMotionProject,
  encodeMotionProject,
  motionEvents,
  MOTION_JSON_MAX_BYTES,
} from "./project";

export type Artwork = ReturnType<typeof characterArtwork>;
export function characterArtwork(bundle: CharacterBundle) {
  return Object.fromEntries(bundle.layers.map((l) => [l.id, croppedCanvas(l.image)]));
}
export function drawMotion(
  ctx: CanvasRenderingContext2D,
  bundle: CharacterBundle,
  artwork: Artwork,
  project: MotionProject,
  pose: MotionPose,
) {
  const result = retargetPose(bundle.plan, project.binding, pose, project.settings.footTargets),
    matrices = poseTransforms(bundle.plan, result.angles);
  let clipped = false;
  ctx.save();
  ctx.translate(result.root.x, result.root.y);
  for (const layer of bundle.layers) {
    const art = artwork[layer.id],
      m = matrices[layer.id] ?? [1, 0, 0, 1, 0, 0];
    if (!art?.canvas.width) continue;
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(art.canvas, art.x, art.y);
    ctx.restore();
    const padding = project.settings.padding;
    for (const p of [
      { x: art.x, y: art.y },
      { x: art.x + art.canvas.width, y: art.y },
      { x: art.x, y: art.y + art.canvas.height },
      { x: art.x + art.canvas.width, y: art.y + art.canvas.height },
    ]) {
      const q = transformPoint(m as [number, number, number, number, number, number], p);
      clipped ||=
        q.x + result.root.x < -padding ||
        q.x + result.root.x > bundle.plan.width + padding ||
        q.y + result.root.y < -padding ||
        q.y + result.root.y > bundle.plan.height + padding;
    }
  }
  ctx.restore();
  return { ...result, matrices, clipped };
}
export async function exportMotionProject(
  project: MotionProject,
  session: CharacterSession,
  bundle: CharacterBundle,
) {
  const original = await exportCharacterZip(bundle, session.source, session.completions);
  const zip = await JSZip.loadAsync(original);
  zip.file("motion.json", encodeMotionProject(project));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  checkCharacterZip(bytes);
  return new Blob([new Uint8Array(bytes)], { type: "application/zip" });
}
export async function importMotionProject(file: File) {
  if (file.size > 64 * 1024 * 1024) throw Error("Character ZIP exceeds 64 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkCharacterZip(bytes);
  const zip = await JSZip.loadAsync(bytes),
    entry = zip.file("motion.json");
  if (!entry)
    throw Error("This project has no motion.json. Use Import character for a layer project.");
  const project = decodeMotionProject(await readCharacterZipFile(entry, MOTION_JSON_MAX_BYTES));
  const session = await importCharacterZip(file);
  const ids = new Set(session.plan.parts.map((p) => p.id));
  if (Object.values(project.binding).some((b) => !ids.has(b!.part)))
    throw Error("Joint mapping refers to a missing artwork part.");
  return { project, session };
}
const blob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error("PNG encoding failed."))), "image/png"),
  );

/** Bake the exact preview recipe. Work is capped before allocating a sheet. */
export async function bakeMotion(
  project: MotionProject,
  bundle: CharacterBundle,
  action: boolean,
  progress: (value: string) => void,
) {
  const recipe = projectSchema.parse(project),
    sample = exportSamples(recipe, action),
    pad = recipe.settings.padding;
  const w = bundle.plan.width + 2 * pad,
    h = bundle.plan.height + 2 * pad,
    count = sample.phases.length;
  if (w > 2048 || h > 2048)
    throw Error(
      "Frame exceeds Sprite Playground's 2048 pixel limit. Use smaller source artwork or reduce padding.",
    );
  if (w * h * count > 32_000_000 || count > 128)
    throw Error(
      "Export exceeds 32 million pixels or 128 frames. Reduce FPS, padding or clip duration.",
    );
  const cols = Math.min(count, 8, Math.floor(8192 / w)),
    rows = Math.ceil(count / cols);
  if (cols < 1 || rows * h > 8192)
    throw Error("Sheet exceeds 8192 pixels per side. Reduce padding or FPS.");
  const canvas = document.createElement("canvas");
  canvas.width = w * cols;
  canvas.height = h * rows;
  const ctx = canvas.getContext("2d")!,
    artwork = characterArtwork(bundle),
    frames = [];
  let anyClipped = false;
  for (const [i, phase] of sample.phases.entries()) {
    const basePhase = action
      ? (phase * sample.duration) / evaluateMotion(recipe, 0).duration
      : phase;
    const { pose } = evaluateMotion(recipe, basePhase, action ? phase : undefined);
    ctx.save();
    ctx.translate((i % cols) * w + pad, Math.floor(i / cols) * h + pad);
    const result = drawMotion(ctx, bundle, artwork, recipe, pose);
    ctx.restore();
    anyClipped ||= result.clipped;
    const weapon = recipe.binding.weapon?.part;
    const grip = weapon ? bundle.plan.parts.find((p) => p.id === weapon)?.pivot : undefined;
    const p = grip && weapon ? transformPoint(result.matrices[weapon], grip) : undefined;
    frames.push({
      frame: i,
      phase,
      durationMs: (sample.duration * 1000) / count,
      contacts: pose.contacts,
      root: result.root,
      angles: result.angles,
      weapon: p ? { x: p.x + pad + result.root.x, y: p.y + pad + result.root.y } : null,
      warnings: result.warnings,
      clipped: result.clipped,
    });
    progress(`Rendering frame ${i + 1} / ${count}`);
    // Give the browser a chance to paint progress between frames.
    if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (anyClipped)
    throw Error(
      "Artwork leaves the export canvas. Increase export padding or adjust the motion before baking.",
    );
  const id = action
    ? recipe.settings.action
    : recipe.settings.mode === "locomotion"
      ? "locomotion"
      : recipe.settings.selected;
  const zip = new JSZip(),
    duration = (sample.duration * 1000) / count;
  zip.file(`${id}.png`, await blob(canvas));
  zip.file("motion.json", encodeMotionProject(recipe));
  zip.file(
    "frames.json",
    JSON.stringify(
      {
        format: "sprite-tools-motion-frames",
        version: 1,
        id,
        canvas: { width: w, height: h },
        origin: { x: bundle.plan.origin.x + pad, y: bundle.plan.origin.y + pad },
        grid: { cols, rows },
        frames,
        events: motionEvents(recipe, action),
        units: "source pixels; angles are local degrees; phase is normalized",
        inPlace: true,
      },
      null,
      2,
    ),
  );
  const key =
    recipe.settings.mode === "locomotion" && !action
      ? "walk"
      : id === "stab" || id === "sweep"
        ? "attack1"
        : id;
  zip.file(
    "animation-set.json",
    JSON.stringify(
      {
        version: 1,
        character: "Motion workbench export",
        canvas: { width: w, height: h },
        origin: { x: bundle.plan.origin.x + pad, y: bundle.plan.origin.y + pad },
        clips: {
          [id]: {
            sheet: `./${id}.png`,
            grid: { cols, rows },
            count,
            durations: Array(count).fill(duration),
            loop: sample.loop,
          },
        },
        controller: {
          restPose: "hold",
          bindings: {
            idle: null,
            walk: null,
            run: null,
            jump: null,
            roll: null,
            attack1: null,
            attack2: null,
            attack3: null,
            crouchDown: null,
            crouch: null,
            crouchUp: null,
            crouchAttack: null,
            lowAttack: null,
            ...(["idle", "walk", "run", "jump", "attack1"].includes(key) ? { [key]: id } : {}),
          },
        },
      },
      null,
      2,
    ),
  );
  zip.file(
    "README.txt",
    "Transparent sprite sheet baked locally from an editable motion recipe. frames.json contains sampled poses, contacts, weapon positions and normalized events. Review target reach warnings before use. animation-set.json can be opened in Sprite Playground when served beside the PNG. motion.json preserves the reusable rig binding and motion library; artwork is stored in the separate saved project ZIP.\n",
  );
  progress("Packing sheet and motion data…");
  return zip.generateAsync({ type: "blob" });
}

export function motionStore(value?: {
  project: MotionProject;
  session: CharacterSession;
  name: string;
}): Promise<{ project: MotionProject; session: CharacterSession; name: string } | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sprite-tools-motion-workbench", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("draft");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result,
        tx = db.transaction("draft", value ? "readwrite" : "readonly");
      const operation = value
        ? tx.objectStore("draft").put(value, "current")
        : tx.objectStore("draft").get("current");
      let result: typeof value | null = null;
      operation.onsuccess = () => {
        if (!value) result = operation.result ?? null;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result ?? null);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
