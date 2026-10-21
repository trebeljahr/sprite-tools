import { completionBackground, removeCompletionBackground } from "./completion";
import { renderCharacterPose } from "./pose";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadPng, savePng, imageToPngBuffer, readPngSize } from "../../../cli/lib/image-io";
import { prepareCharacter, characterManifest } from "./core";
import { CHARACTER_AI, draftCharacterPlan, completeCharacterPart, type AiAccess } from "./ai";
import { validatePlan, MAX_CHARACTER_PIXELS, type CharacterPlan, type Pixels } from "./types";

export interface CharacterOptions {
  input: string;
  output: string;
  plan?: unknown;
  aiDraft?: boolean;
  description?: string;
  completeParts?: string[];
  completionPaths?: Record<string, string>;
  allowPaid?: boolean;
  maxCostUsd?: number;
  retryUncertain?: boolean;
  bendTestParts?: string[];
}
function hash(s: string | Uint8Array) {
  return createHash("sha256").update(s).digest("hex");
}
function boundedPng(file: string): Pixels {
  const size = readPngSize(file);
  if (!size || size.width * size.height > MAX_CHARACTER_PIXELS)
    throw new Error("Use a PNG source at most 4 megapixels.");
  return loadPng(file);
}
export function decodeCompletion(
  dataUrl: string,
  plan: Pick<CharacterPlan, "width" | "height">,
): Pixels {
  const dir = mkdtempSync(join(tmpdir(), "sprite-character-decode-"));
  try {
    const input = join(dir, "input"),
      output = join(dir, "output.png");
    const b64 = dataUrl.split(",")[1];
    if (!b64) throw new Error("Completion image is missing.");
    const bytes = Buffer.from(b64, "base64");
    const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp =
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp)
      throw new Error("Provider completion is not a PNG, JPEG or WebP image.");
    writeFileSync(input, bytes, { mode: 0o600 });
    if (dataUrl.startsWith("data:image/png")) {
      const im = boundedPng(input);
      if (im.width === plan.width && im.height === plan.height) return im;
    }
    let info: { streams?: Array<{ width: number; height: number }> };
    try {
      info = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            input,
          ],
          { timeout: 15_000, maxBuffer: 1024 * 1024 },
        ).toString(),
      );
    } catch {
      throw new Error(
        "Install ffmpeg/ffprobe to decode JPEG/WebP or resize provider completions. Aligned PNG completion imports work without them.",
      );
    }
    const size = info.streams?.[0];
    if (
      !size ||
      size.width * size.height > 16_777_216 ||
      Math.abs(size.width / size.height / (plan.width / plan.height) - 1) > 0.015
    )
      throw new Error(
        "Completion changed canvas aspect ratio or exceeds 16 megapixels. Align and import it as a PNG.",
      );
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        input,
        "-vf",
        `scale=${plan.width}:${plan.height}`,
        "-frames:v",
        "1",
        "-threads",
        "1",
        output,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return boundedPng(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Explicit paid opt-in, content-addressed results, no automatic retries after uncertain dispatch. */
export async function runCharacter(options: CharacterOptions, access?: AiAccess) {
  if (Boolean(options.plan) === Boolean(options.aiDraft))
    throw new Error("Supply exactly one plan or ai_draft.");
  const source = boundedPng(options.input),
    png = imageToPngBuffer(source as ImageData),
    sourceHash = hash(png);
  const output = resolve(options.output),
    cacheDir = join(output, ".character-cache");
  if (
    existsSync(output) &&
    readdirSync(output).length &&
    !existsSync(cacheDir) &&
    !existsSync(join(output, "character.json"))
  )
    throw new Error("Choose an empty output directory or an existing character bundle.");
  mkdirSync(cacheDir, { recursive: true });
  let reservedUsd = 0,
    cachedRequests = 0;
  const paid = async <T>(
    kind: string,
    content: unknown,
    cost: number,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const key = hash(
        JSON.stringify({
          kind,
          sourceHash,
          content,
          models: {
            planner: CHARACTER_AI.planner,
            editor: CHARACTER_AI.editor,
            quality: "low",
            resolution: "1k",
          },
        }),
      ),
      path = join(cacheDir, `${key}.json`);
    if (existsSync(path)) {
      const entry = JSON.parse(readFileSync(path, "utf8"));
      if (entry.state === "done") {
        cachedRequests++;
        return entry.result as T;
      }
      if (!options.retryUncertain)
        throw new Error(
          "An earlier layer request has an uncertain outcome. Check provider usage, then explicitly use retry_uncertain to pay for a new attempt.",
        );
    }
    if (!options.allowPaid || !access?.apiKey.trim())
      throw new Error(
        "Paid automation requires allow_paid and XAI_API_KEY in the CLI/MCP environment. No provider request was sent.",
      );
    if (
      !Number.isFinite(options.maxCostUsd) ||
      (options.maxCostUsd ?? 0) < reservedUsd + cost - 1e-9
    )
      throw new Error(
        "Layer request exceeds max_cost_usd. No additional provider request was sent.",
      );
    reservedUsd = Math.round((reservedUsd + cost) * 1e6) / 1e6;
    // Exclusive creation also prevents two processes dispatching the same content simultaneously.
    if (options.retryUncertain && existsSync(path))
      renameSync(path, `${path}.previous-${Date.now()}`);
    writeFileSync(path, JSON.stringify({ state: "started", kind, reservedUsd: cost, sourceHash }), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      const result = await fn();
      const temp = `${path}.tmp`;
      writeFileSync(
        temp,
        JSON.stringify({ state: "done", kind, reservedUsd: cost, sourceHash, result }),
        { mode: 0o600 },
      );
      renameSync(temp, path);
      return result;
    } catch {
      throw new Error(
        "Layer provider request failed or timed out. Its reservation remains uncertain; no retry was made. Check provider usage before retry_uncertain.",
      );
    }
  };
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const plan = options.aiDraft
    ? await paid("plan", options.description ?? "", CHARACTER_AI.planningReservationUsd, () =>
        draftCharacterPlan(
          { image, width: source.width, height: source.height, description: options.description },
          access!,
        ),
      )
    : validatePlan(options.plan);
  const completions: Record<string, Pixels> = {};
  const kinds: Record<string, "imported" | "generated"> = {};
  for (const [id, file] of Object.entries(options.completionPaths ?? {}))
    completions[id] = boundedPng(file);
  let bundle = prepareCharacter(source, plan, completions);
  const wanted = options.completeParts?.includes("all")
    ? plan.parts.map((p) => p.id)
    : (options.completeParts ?? []);
  for (const id of wanted)
    if (!plan.parts.some((p) => p.id === id)) throw new Error(`Unknown part: ${id}`);
  // Export a useful draft even when the next requested paid step hits its cap.
  const exportBundle = () => {
    for (const l of bundle.layers)
      for (const [folder, im] of Object.entries({
        layers: l.image,
        visible: l.visible,
        generated: l.generated,
        masks: l.hiddenMask,
      })) {
        const dir = join(output, folder);
        mkdirSync(dir, { recursive: true });
        savePng(im as ImageData, join(dir, `${l.id}.png`));
      }
    for (const [id, im] of Object.entries(completions)) {
      const dir = join(output, "completions");
      mkdirSync(dir, { recursive: true });
      savePng(im as ImageData, join(dir, `${id}.png`));
    }
    savePng(source as ImageData, join(output, "source.png"));
    savePng(bundle.reconstruction as ImageData, join(output, "reconstruction.png"));
    writeFileSync(join(output, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    const manifest = characterManifest(bundle, sourceHash);
    writeFileSync(join(output, "character.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  };
  exportBundle();
  for (const id of [...new Set(wanted)]) {
    const layer = bundle.layers.find((l) => l.id === id)!;
    if (!layer.hiddenPixels || completions[id]) continue;
    const part = plan.parts.find((p) => p.id === id)!;
    const data = await paid("completion", { part, plan }, CHARACTER_AI.completionEstimateUsd, () =>
      completeCharacterPart(
        { image, plan, part, background: completionBackground(source) },
        access!,
      ),
    );
    completions[id] = removeCompletionBackground(
      decodeCompletion(data, plan),
      completionBackground(source),
    );
    kinds[id] = "generated";
    bundle = prepareCharacter(source, plan, completions, kinds);
    exportBundle();
  }
  const bendParts = options.bendTestParts?.includes("all")
    ? plan.parts.map((p) => p.id)
    : (options.bendTestParts ?? []);
  const bends = [];
  for (const id of bendParts) {
    if (!plan.parts.some((p) => p.id === id)) throw new Error(`Unknown bend-test part: ${id}`);
    for (const angle of [-35, 35]) {
      const pose = renderCharacterPose(bundle, { [id]: angle }),
        dir = join(output, "bend-tests");
      mkdirSync(dir, { recursive: true });
      const file = `${id}-${angle < 0 ? "minus" : "plus"}.png`;
      savePng(pose.image as ImageData, join(dir, file));
      bends.push({
        part: id,
        angle,
        file: `bend-tests/${file}`,
        mayClip: pose.mayClip,
        origin: pose.origin,
      });
    }
  }
  if (bends.length)
    writeFileSync(
      join(output, "bend-tests.json"),
      `${JSON.stringify({ note: "Rigid joint stress poses for visual review. Does not certify anatomy, skinning or absence of gaps.", poses: bends }, null, 2)}\n`,
    );
  return {
    bendTests: bends,
    path: join(output, "character.json"),
    planPath: join(output, "plan.json"),
    outputDir: output,
    reservedUsd,
    cachedRequests,
    ...exportBundle(),
  };
}
