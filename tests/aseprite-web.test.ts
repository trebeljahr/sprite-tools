// Web import wiring for .ase/.aseprite: the DOM-free decisions the source
// picker and importFromAseprite make, plus a bundle-safety guard.
//
// The pixel decoding itself is covered by aseprite.test.ts. What is asserted
// here is the layer between the decoder and the pipeline: which layers a user
// may pick, which frames an import produces and what they are called, where
// non-fatal notes go, and that per-frame durations survive the pipeline's
// dedupe step the same way main's tags-document remap carries them.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type AseDocument, compositeFrame, parseAseprite } from "@/lib/aseprite";
import { inflateNode } from "@/lib/aseprite/inflate-node";
import { normalizeFrameDurations } from "@/lib/animation/durations";
import { applyDedupe, findDuplicateFrames, remapFrameDurations } from "@/lib/pipeline/dedupe-core";
import {
  asepriteLayerChoices,
  isAsepriteFilename,
  planAsepriteImport,
  toggleAsepriteLayer,
} from "@/lib/pipeline/import";

const ALL = { includeHiddenLayers: false } as const;

function fixture(relative: string): Promise<AseDocument> {
  const url = new URL(`./fixtures/aseprite/${relative}`, import.meta.url);
  return parseAseprite(new Uint8Array(readFileSync(fileURLToPath(url))), {
    inflate: inflateNode,
  });
}

describe("isAsepriteFilename", () => {
  it("routes on the extension, case-insensitively, because File.type is empty for both", () => {
    expect(isAsepriteFilename("hero.ase")).toBe(true);
    expect(isAsepriteFilename("hero.aseprite")).toBe(true);
    expect(isAsepriteFilename("HERO.ASEPRITE")).toBe(true);
    expect(isAsepriteFilename("hero.png")).toBe(false);
    expect(isAsepriteFilename("hero.ase.png")).toBe(false);
    expect(isAsepriteFilename("aseprite")).toBe(false);
  });
});

describe("asepriteLayerChoices", () => {
  it("offers a reference layer only as disabled, with the reason", async () => {
    const doc = await fixture("generated/rgba-reference-layer.aseprite");
    const choices = asepriteLayerChoices(doc, false);
    expect(choices.map((c) => c.name)).toEqual(["Art", "Reference"]);
    expect(choices[0].disabledReason).toBeUndefined();
    expect(choices[1].disabledReason).toMatch(/reference/i);
    // Hidden layers turning on does not make a reference layer render.
    expect(asepriteLayerChoices(doc, true)[1].disabledReason).toMatch(/reference/i);
  });

  it("leaves groups out, keeps their children, and gates hidden layers on includeHidden", async () => {
    const doc = await fixture("generated/layers-blend.aseprite");
    const off = asepriteLayerChoices(doc, false);
    expect(off.map((c) => c.name)).toEqual(["Base", "Mult", "Hidden", "Add"]);
    expect(off.find((c) => c.name === "Add")?.childLevel).toBe(1);
    expect(off.find((c) => c.name === "Hidden")?.disabledReason).toMatch(/hidden/i);
    const on = asepriteLayerChoices(doc, true);
    expect(on.every((c) => c.disabledReason === undefined)).toBe(true);
  });
});

describe("toggleAsepriteLayer", () => {
  it("deselects from 'all', and collapses back to null once every layer is on again", async () => {
    const choices = asepriteLayerChoices(await fixture("generated/layers-blend.aseprite"), false);
    const withoutMult = toggleAsepriteLayer(null, "Mult", choices);
    expect(withoutMult).toEqual(["Base", "Add"]);
    expect(toggleAsepriteLayer(withoutMult, "Mult", choices)).toBeNull();
  });

  it("ignores clicks on layers that cannot contribute", async () => {
    const choices = asepriteLayerChoices(
      await fixture("generated/rgba-reference-layer.aseprite"),
      false,
    );
    expect(toggleAsepriteLayer(null, "Reference", choices)).toBeNull();
    const current = ["Art"];
    expect(toggleAsepriteLayer(current, "Reference", choices)).toBe(current);
  });

  it("refuses to deselect the last layer that would render anything", async () => {
    const ref = asepriteLayerChoices(
      await fixture("generated/rgba-reference-layer.aseprite"),
      false,
    );
    // "Art" is the only selectable layer; turning it off would import blanks.
    expect(toggleAsepriteLayer(null, "Art", ref)).toBeNull();

    const blend = asepriteLayerChoices(await fixture("generated/layers-blend.aseprite"), false);
    // A selection still holding a now-hidden layer counts only what renders.
    expect(toggleAsepriteLayer(["Base", "Hidden"], "Base", blend)).toEqual(["Base", "Hidden"]);
  });
});

describe("planAsepriteImport", () => {
  it("imports every frame with durations in main's model and tag names in filenames", async () => {
    const doc = await fixture("generated/tags-directions.aseprite");
    const plan = planAsepriteImport(doc, ALL, "My Hero.aseprite");
    expect(plan.layerIndices).toBeUndefined();
    expect(plan.frames.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(plan.frames[0].filename).toBe("My-Hero-forward-0000.png");
    expect(plan.frames[11].filename).toBe("My-Hero-pingpong_reverse-0011.png");
    expect(plan.frames.every((f) => f.durationMs === 100)).toBe(true);
    expect(doc.warnings).toEqual([]);
  });

  it("restricts a tag import to its range, keeping source indices", async () => {
    const doc = await fixture("generated/tags-directions.aseprite");
    const plan = planAsepriteImport(doc, { ...ALL, tag: "reverse" }, "a.ase");
    expect(plan.frames.map((f) => f.index)).toEqual([4, 5, 6, 7]);
    expect(plan.frames.map((f) => f.filename)).toEqual([
      "a-reverse-0004.png",
      "a-reverse-0005.png",
      "a-reverse-0006.png",
      "a-reverse-0007.png",
    ]);
  });

  it("carries per-frame durations as whole milliseconds", async () => {
    const doc = await fixture("generated/rgba-durations.aseprite");
    const plan = planAsepriteImport(doc, ALL, "d.aseprite");
    expect(plan.frames.map((f) => f.durationMs)).toEqual([100, 250, 40, 33]);
  });

  it("clamps an out-of-range tag and says so in doc.warnings", async () => {
    const doc = await fixture("generated/tags-directions.aseprite");
    doc.tags.push({ name: "broken", from: 10, to: 40, direction: "forward", repeat: 0 });
    const plan = planAsepriteImport(doc, { ...ALL, tag: "broken" }, "a.ase");
    expect(plan.frames.map((f) => f.index)).toEqual([10, 11]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]).toMatch(/clamped to 10-11/);
    // A second run adds no duplicate note.
    planAsepriteImport(doc, { ...ALL, tag: "broken" }, "a.ase");
    expect(doc.warnings).toHaveLength(1);
  });

  it("throws on a tag with no frames inside the document instead of importing nothing", async () => {
    const doc = await fixture("generated/tags-directions.aseprite");
    doc.tags.push({ name: "gone", from: 50, to: 60, direction: "forward", repeat: 0 });
    expect(() => planAsepriteImport(doc, { ...ALL, tag: "gone" }, "a.ase")).toThrow(/gone/);
  });

  it("warns when a named tag or layer selection matches nothing", async () => {
    const doc = await fixture("generated/tags-directions.aseprite");
    const plan = planAsepriteImport(doc, { ...ALL, tag: "missing", layerNames: ["Nope"] }, "a.ase");
    expect(plan.frames).toHaveLength(12);
    expect(plan.layerIndices).toBeUndefined();
    expect(doc.warnings.some((w) => /Nope|selected layers exist/.test(w))).toBe(true);
    expect(doc.warnings.some((w) => /"missing"/.test(w))).toBe(true);
  });

  it("resolves layer names to indices and warns when only non-rendering layers are selected", async () => {
    const doc = await fixture("generated/layers-blend.aseprite");
    const plan = planAsepriteImport(doc, { ...ALL, layerNames: ["Base", "Add"] }, "b.ase");
    expect(plan.layerIndices).toEqual([0, 4]);
    expect(doc.warnings.filter((w) => /imported frames are empty/.test(w))).toEqual([]);

    const hiddenOnly = planAsepriteImport(doc, { ...ALL, layerNames: ["Hidden"] }, "b.ase");
    expect(hiddenOnly.layerIndices).toEqual([2]);
    expect(doc.warnings.some((w) => /imported frames are empty/.test(w))).toBe(true);
  });
});

describe("durations through the dedupe step", () => {
  it("stay attached to their frames and agree with main's remapFrameDurations", async () => {
    const doc = await fixture("generated/rgba-durations.aseprite");
    const plan = planAsepriteImport(doc, ALL, "d.aseprite");
    // Sequence with a repeated drawing, the case dedupe exists for: frame 1
    // appears twice, so dedupe removes position 2 and renumbers 3 and 4.
    const order = [0, 1, 1, 2, 3];
    const frames = order.map((i) => ({
      image: compositeFrame(doc, i),
      metadata: { durationMs: plan.frames[i].durationMs },
    }));
    const result = findDuplicateFrames(
      frames.map((f) => ({ width: f.image.width, height: f.image.height, data: f.image.pixels })),
    );
    expect(result.keptIndices).toEqual([0, 1, 3, 4]);

    // What the pipeline does: keep Frame objects, metadata travels with them.
    const kept = applyDedupe(frames, result);
    const carried = normalizeFrameDurations(
      kept.map((f) => f.metadata.durationMs),
      kept.length,
    );
    expect(carried).toEqual([100, 250, 40, 33]);
    // What the tags-document path does with a frame-indexed array.
    expect(
      remapFrameDurations(
        frames.map((f) => f.metadata.durationMs),
        result,
      ),
    ).toEqual(carried);
  });
});

// -----------------------------------------------------------------
// Bundle safety
// -----------------------------------------------------------------
// `pnpm build` is the real check, but it is slow and a Node built-in in the
// client graph only fails there. Walk the static import graph of both pages
// that offer the Aseprite tab and assert nothing reaches node:* or the Node
// inflater, so the mistake fails in `pnpm test` too.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // bare package: not ours to walk
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/") && /\.(ts|tsx)$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function reachableModules(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) {
      // Type-only imports are erased and never reach the bundle.
      if (/^(?:import|export)\s+type\s/.test(m[0])) continue;
      const spec = m[1];
      const target = resolveSpecifier(file, spec);
      if (target) queue.push(target);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) bare.add(spec);
    }
  }
  return { files, bare };
}

describe("client bundle", () => {
  for (const page of ["app/spritesheet/page.tsx", "app/background-removal/page.tsx"]) {
    it(`${page} never reaches node:zlib or the Node inflater`, () => {
      const { files, bare } = reachableModules(resolve(SRC, page));
      expect(files.has(resolve(SRC, "lib/pipeline/import.ts"))).toBe(true);
      expect(files.has(resolve(SRC, "lib/aseprite/inflate.ts"))).toBe(true);
      expect([...files].filter((f) => f.endsWith("inflate-node.ts"))).toEqual([]);
      expect([...bare].filter((s) => s.startsWith("node:") || s === "zlib")).toEqual([]);
    });
  }
});
