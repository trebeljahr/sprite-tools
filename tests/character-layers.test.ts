import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  composite,
  pixels,
  poseTransforms,
  prepareCharacter,
  characterManifest,
} from "../src/lib/character/core";
import { completionBackground, removeCompletionBackground } from "../src/lib/character/completion";
import { characterDemo } from "../src/lib/character/demo";
import { validatePlan, type CharacterPlan } from "../src/lib/character/types";
import { completeCharacterPart, draftCharacterPlan } from "../src/lib/character/ai";
import { runCharacter } from "../src/lib/character/node";
import { imageToPngBuffer, loadPng, savePng } from "../cli/lib/image-io";
import { registerCharacterCommand } from "../cli/commands/character";
import { registerCharacterTools } from "../mcp/character-tools";

const rect = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const plan: CharacterPlan = {
  version: 1,
  width: 4,
  height: 4,
  origin: { x: 2, y: 4 },
  notes: [],
  parts: [
    {
      id: "body",
      name: "Body",
      parent: null,
      pivot: { x: 2, y: 2 },
      tip: { x: 2, y: 1 },
      polygon: rect(0, 0, 4, 4),
      description: "cloth",
    },
    {
      id: "arm",
      name: "Arm",
      parent: "body",
      pivot: { x: 2, y: 2 },
      tip: { x: 3, y: 2 },
      polygon: rect(2, 0, 2, 4),
      description: "right screen side",
    },
  ],
};
function source() {
  const p = pixels(4, 4);
  for (let k = 0; k < p.data.length; k += 4) p.data.set([k, 75, 110, 255], k);
  p.data[3] = 100;
  p.data[7] = 0;
  return p;
}
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "character-layers-test-"));
  roots.push(root);
  savePng(source() as ImageData, join(root, "source.png"));
  return { root, input: join(root, "source.png"), output: join(root, "out") };
}
const inline = () =>
  `data:image/png;base64,${imageToPngBuffer(source() as ImageData).toString("base64")}`;
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("character pixel ownership and completion", () => {
  it("preserves every visible pixel and soft alpha edge, with or without hidden fill", () => {
    const s = source(),
      fill = source();
    fill.data.fill(255);
    const b = prepareCharacter(s, plan, { body: fill });
    expect(b.report.changedPixels).toBe(0);
    expect(b.reconstruction.data).toEqual(composite([s]).data);
    expect(b.layers.find((l) => l.id === "body")!.hiddenPixels).toBe(8);
    expect(b.layers.find((l) => l.id === "body")!.filledPixels).toBe(8);
    expect(b.layers.find((l) => l.id === "body")!.generated.data[3]).toBe(0);
    expect(b.layers.find((l) => l.id === "arm")!.visible.data[11]).toBe(255);
  });
  it("keeps unassigned pixels in a separate layer rather than losing them", () => {
    const p = { ...plan, parts: [{ ...plan.parts[0], polygon: rect(0, 0, 1, 4) }] };
    const b = prepareCharacter(source(), p);
    expect(b.report.unassignedPixels).toBeGreaterThan(0);
    expect(b.layers[0].id).toBe("unassigned");
    expect(b.report.changedPixels).toBe(0);
  });
  it("distinguishes imported and generated hidden pixels per part", () => {
    const b = prepareCharacter(source(), plan, { body: source() }, { body: "generated" });
    expect(b.layers[0].completion).toBe("generated");
    expect(prepareCharacter(source(), plan, { body: source() }).layers[0].completion).toBe(
      "imported",
    );
  });
  it("does not paint under partially transparent front edges", () => {
    const s = source();
    s.data[11] = 127;
    const b = prepareCharacter(s, plan, { body: source() });
    expect(b.layers[0].generated.data[11]).toBe(0);
    expect(b.report.changedPixels).toBe(0);
  });
  it("exports a complete common-canvas layer contract", () => {
    const b = prepareCharacter(source(), plan),
      m = characterManifest(b, "hash");
    expect(m.canvas).toEqual({ width: 4, height: 4 });
    expect(m.layers[0].visible).toBe("visible/body.png");
    expect(m.layers[0].hiddenMask).toBe("masks/body.png");
    expect(m.plan.parts[1].parent).toBe("body");
  });
  it("rejects wrong-sized completions and unknown part ids", () => {
    expect(() => prepareCharacter(source(), plan, { body: pixels(2, 2) })).toThrow(/canvas/);
    expect(() => prepareCharacter(source(), plan, { other: source() })).toThrow(/Unknown/);
  });
  it("reconstructs the layered offline example without changing artwork", () => {
    const d = characterDemo(),
      b = prepareCharacter(d.source, d.plan, d.completions);
    expect(b.report.changedPixels).toBe(0);
    expect(b.report.unassignedPixels).toBe(0);
    expect(b.layers.some((l) => l.filledPixels > 0)).toBe(true);
  });
  it("rejects hierarchy cycles, duplicate/unsafe ids, nonfinite coordinates and excessive allocation", () => {
    expect(() =>
      validatePlan({ ...plan, parts: [{ ...plan.parts[0], parent: "arm" }, plan.parts[1]] }),
    ).toThrow(/cycle/);
    expect(() => validatePlan({ ...plan, parts: [plan.parts[0], plan.parts[0]] })).toThrow(
      /unique/,
    );
    expect(() => validatePlan({ ...plan, parts: [{ ...plan.parts[0], id: "../key" }] })).toThrow();
    expect(() => validatePlan({ ...plan, origin: { x: NaN, y: 0 } })).toThrow();
    expect(() => validatePlan({ ...plan, width: 4096, height: 4096 })).toThrow(/megapixels/);
    expect(() =>
      validatePlan({
        ...plan,
        width: 2048,
        height: 2048,
        parts: Array.from({ length: 9 }, (_, i) => ({ ...plan.parts[0], id: `part-${i}` })),
      }),
    ).toThrow(/layer pixels/);
  });
  it("inherits parent motion while rotating around source-image joint pivots", () => {
    const t = poseTransforms(plan, { body: 90 }),
      a = t.arm;
    const x = a[0] * 3 + a[2] * 2 + a[4],
      y = a[1] * 3 + a[3] * 2 + a[5];
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(3);
    expect(poseTransforms(plan, {}).arm).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
describe("bounded provider adapters", () => {
  it("requests a schema-validated image-aware plan and never sends the key anywhere else", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
    );
    expect(
      await draftCharacterPlan(
        { image: inline(), width: 4, height: 4 },
        { apiKey: " secret ", fetchImpl: f as typeof fetch },
      ),
    ).toEqual(plan);
    expect(f.mock.calls[0][0]).toBe("https://api.x.ai/v1/chat/completions");
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body)).max_tokens).toBe(8000);
  });
  it("pins completion cost settings and asks for an aligned isolated part", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: inline().split(",")[1] }] }),
    );
    const result = await completeCharacterPart(
      { image: inline(), plan, part: plan.parts[0] },
      { apiKey: "secret", fetchImpl: f as typeof fetch },
    );
    expect(result).toBe(inline());
    const init = f.mock.calls[0][1] as RequestInit;
    const b = JSON.parse(String(init.body));
    expect(b.quality).toBe("low");
    expect(b.resolution).toBe("1k");
    expect(b.n).toBe(1);
    expect(f.mock.calls[0][0]).toBe("https://api.x.ai/v1/images/edits");
  });
  it("rejects remote image URLs and invalid provider plans without retry", async () => {
    const f = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { content: "{}" } }] }),
    );
    await expect(
      draftCharacterPlan(
        { image: "https://other.example/private.png", width: 4, height: 4 },
        { apiKey: "secret", fetchImpl: f as typeof fetch },
      ),
    ).rejects.toThrow(/local/);
    expect(f).not.toHaveBeenCalled();
    await expect(
      draftCharacterPlan(
        { image: inline(), width: 4, height: 4 },
        { apiKey: "secret", fetchImpl: f as typeof fetch },
      ),
    ).rejects.toThrow(/Invalid character plan/);
    expect(f).toHaveBeenCalledOnce();
  });
  it("does not echo provider errors or secrets", async () => {
    const f = vi.fn<typeof fetch>(
      async () => new Response("secret-token-should-not-leak", { status: 403 }),
    );
    await expect(
      draftCharacterPlan(
        { image: inline(), width: 4, height: 4 },
        { apiKey: "secret", fetchImpl: f as typeof fetch },
      ),
    ).rejects.toThrow("HTTP 403");
    expect(f).toHaveBeenCalledOnce();
  });
});
describe("headless automation", () => {
  it("writes aligned original/generated/mask files with no network for a supplied plan", async () => {
    const f = fixture(),
      fetchImpl = vi.fn();
    const b = await runCharacter({ ...f, plan }, { apiKey: "", fetchImpl });
    expect(b.reservedUsd).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadPng(join(f.output, "reconstruction.png")).data).toEqual(composite([source()]).data);
    expect(b.report.changedPixels).toBe(0);
  });
  it("refuses paid requests without explicit consent and spend cap", async () => {
    const f = fixture(),
      fetchImpl = vi.fn();
    await expect(
      runCharacter({ ...f, aiDraft: true }, { apiKey: "secret", fetchImpl }),
    ).rejects.toThrow(/allow_paid/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      runCharacter(
        { ...f, aiDraft: true, allowPaid: true, maxCostUsd: 0.01 },
        { apiKey: "secret", fetchImpl },
      ),
    ).rejects.toThrow(/max_cost/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("caches completed plans across invocations without another charge", async () => {
    const f = fixture(),
      fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
      );
    const a = await runCharacter(
      { ...f, aiDraft: true, allowPaid: true, maxCostUsd: 0.05 },
      { apiKey: "secret", fetchImpl: fetchImpl as typeof fetch },
    );
    expect(a.reservedUsd).toBe(0.05);
    const b = await runCharacter(
      { ...f, aiDraft: true },
      { apiKey: "", fetchImpl: fetchImpl as typeof fetch },
    );
    expect(b.reservedUsd).toBe(0);
    expect(b.cachedRequests).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.output, "character.json"), "utf8")).not.toContain("secret");
  });
  it("blocks uncertain dispatch even on a later invocation", async () => {
    const f = fixture(),
      fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error("network failure secret");
      });
    const opt = { ...f, aiDraft: true, allowPaid: true, maxCostUsd: 0.05 };
    await expect(runCharacter(opt, { apiKey: "secret", fetchImpl })).rejects.toThrow(/uncertain/);
    await expect(runCharacter(opt, { apiKey: "secret", fetchImpl })).rejects.toThrow(/uncertain/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("enforces a combined cap and preserves the successful plan when completion cannot dispatch", async () => {
    const f = fixture(),
      fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
      );
    await expect(
      runCharacter(
        { ...f, aiDraft: true, completeParts: ["body"], allowPaid: true, maxCostUsd: 0.05 },
        { apiKey: "secret", fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toThrow(/max_cost/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(f.output, "plan.json"), "utf8"))).toEqual(plan);
  });
  it("runs completion through decoding and masks while preserving original artwork", async () => {
    const f = fixture(),
      fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ data: [{ b64_json: inline().split(",")[1] }] }),
      );
    const r = await runCharacter(
      { ...f, plan, completeParts: ["body"], allowPaid: true, maxCostUsd: 0.05 },
      { apiKey: "secret", fetchImpl: fetchImpl as typeof fetch },
    );
    expect(r.report.changedPixels).toBe(0);
    expect(r.layers[0].completion).toBe("generated");
    expect(r.layers[0].filledPixels).toBe(8);
  });
  it("exposes the local workflow through the real CLI command", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "plan.json"), JSON.stringify(plan));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const p = new Command();
    registerCharacterCommand(p);
    await p.parseAsync([
      "node",
      "test",
      "character",
      f.input,
      "--plan",
      join(f.root, "plan.json"),
      "-o",
      f.output,
    ]);
    expect(out).toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(f.output, "character.json"), "utf8")).report.changedPixels,
    ).toBe(0);
  });
  it("exposes MCP without credential arguments and performs local extraction", async () => {
    const f = fixture();
    let handler: (v: Record<string, unknown>) => Promise<unknown> = async () => null;
    let schema: Record<string, unknown> = {};
    registerCharacterTools({
      registerTool: (
        _n: string,
        o: { inputSchema: Record<string, unknown> },
        h: typeof handler,
      ) => {
        schema = o.inputSchema;
        handler = h;
      },
    } as unknown as McpServer);
    expect(schema).not.toHaveProperty("api_key");
    const r = (await handler({
      input_path: f.input,
      output_dir: f.output,
      plan,
      ai_draft: false,
      complete_parts: [],
      allow_paid: false,
      max_cost_usd: 0,
      retry_uncertain: false,
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).report.changedPixels).toBe(0);
  });
});

describe("project ZIP limits", () => {
  it("accepts normal project directories and bounds actual inflated entries", async () => {
    const { default: JSZip } = await import("jszip");
    const { checkCharacterZip, readCharacterZipFile } = await import(
      "../src/lib/character/zip-guard"
    );
    const z = new JSZip();
    z.file("plan.json", "{}");
    const bytes = await z.generateAsync({ type: "uint8array" });
    expect(() => checkCharacterZip(bytes)).not.toThrow();
    expect(new TextDecoder().decode(await readCharacterZipFile(z.file("plan.json"), 100))).toBe(
      "{}",
    );
    z.file("large.txt", "x".repeat(10000));
    await expect(readCharacterZipFile(z.file("large.txt"), 100)).rejects.toThrow(/size limit/);
  });
  it("rejects truncated or oversized ZIP directories before inflating", async () => {
    const { default: JSZip } = await import("jszip");
    const { checkCharacterZip } = await import("../src/lib/character/zip-guard");
    expect(() => checkCharacterZip(new Uint8Array([1, 2, 3]))).toThrow(/Invalid/);
    const z = new JSZip();
    z.file("plan.json", "{}");
    const b = await z.generateAsync({ type: "uint8array" });
    const d = new DataView(b.buffer);
    for (let p = 0; p < b.length - 46; p++)
      if (d.getUint32(p, true) === 0x02014b50) {
        d.setUint32(p + 24, 25 * 1024 * 1024, true);
        break;
      }
    expect(() => checkCharacterZip(b)).toThrow(/size limit/);
  });
});

describe("headless bend evidence", () => {
  it("keeps a zero-angle render identical to the rest-pose composite", async () => {
    const { renderCharacterPose } = await import("../src/lib/character/pose");
    const b = prepareCharacter(source(), plan, { body: source() });
    expect(renderCharacterPose(b, {}).image.data).toEqual(b.reconstruction.data);
  });
  it("exports requested stress poses without paid requests", async () => {
    const f = fixture(),
      r = await runCharacter({ ...f, plan, bendTestParts: ["arm"] });
    expect(r.bendTests).toHaveLength(2);
    expect(r.bendTests.map((p) => p.angle)).toEqual([-35, 35]);
    expect(r.bendTests[0].origin).toEqual(plan.origin);
    expect(loadPng(join(f.output, "bend-tests/arm-minus.png")).width).toBe(plan.width);
  });
});

describe("reusable completion backgrounds", () => {
  it("chooses a different background for green artwork and preserves the input", () => {
    const s = pixels(2, 1);
    s.data.set([0, 255, 0, 255, 20, 220, 25, 255]);
    expect(completionBackground(s)).toBe("#ff00ff");
    const candidate = pixels(2, 1);
    candidate.data.set([255, 0, 255, 255, 0, 255, 0, 255]);
    const keyed = removeCompletionBackground(candidate, completionBackground(s));
    expect(Array.from(keyed.data)).toEqual([0, 0, 0, 0, 0, 255, 0, 255]);
    expect(candidate.data[3]).toBe(255);
    expect(s.data[3]).toBe(255);
  });
  it("supports a segmented prop with independent drawing and parent order", () => {
    const p = validatePlan({
      ...plan,
      parts: [
        { ...plan.parts[1], id: "flag", name: "Flag", parent: "hinge" },
        { ...plan.parts[0], id: "hinge", name: "Hinge" },
      ],
    });
    const b = prepareCharacter(source(), p);
    expect(b.report.changedPixels).toBe(0);
    const t = poseTransforms(p, { hinge: 90 });
    expect(t.flag).toEqual(t.hinge);
  });
});
