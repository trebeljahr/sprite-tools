import JSZip from "jszip";
import type { CharacterBundle, CharacterPlan, Pixels } from "./types";
import { characterManifest } from "./core";
export function imageCanvas(image: Pixels): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d")!.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
  return c;
}
export async function decodeCharacterImage(
  url: string,
  target?: { width: number; height: number },
): Promise<Pixels> {
  const im = new Image();
  im.src = url;
  await im.decode();
  if (im.naturalWidth * im.naturalHeight > 16_777_216)
    throw new Error("Image exceeds 16 megapixels.");
  if (
    target &&
    Math.abs(im.naturalWidth / im.naturalHeight / (target.width / target.height) - 1) > 0.015
  )
    throw new Error(
      "Completion changed the canvas aspect ratio. Align it externally and import it as a PNG.",
    );
  const c = document.createElement("canvas");
  c.width = target?.width ?? im.naturalWidth;
  c.height = target?.height ?? im.naturalHeight;
  c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
  return c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
}
export async function sha256(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function exportCharacterZip(
  bundle: CharacterBundle,
  source: Pixels,
  completions: Record<string, Pixels>,
  progress: (status: string) => void = () => {},
) {
  progress("Encoding source artwork…");
  const zip = new JSZip();
  const png = (p: Pixels) => imageCanvas(p).toDataURL("image/png").split(",")[1];
  const sourcePng = png(source);
  const bytes = Uint8Array.from(atob(sourcePng), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  zip.file("source.png", sourcePng, { base64: true });
  zip.file("character.json", JSON.stringify(characterManifest(bundle, hash), null, 2));
  zip.file("plan.json", JSON.stringify(bundle.plan, null, 2));
  zip.file("reconstruction.png", png(bundle.reconstruction), { base64: true });
  for (const layer of bundle.layers)
    for (const [folder, image] of Object.entries({
      layers: layer.image,
      visible: layer.visible,
      generated: layer.generated,
      masks: layer.hiddenMask,
    }))
      zip.file(`${folder}/${layer.id}.png`, png(image), { base64: true });
  for (const [id, im] of Object.entries(completions))
    zip.file(`completions/${id}.png`, png(im), { base64: true });
  zip.file(
    "README.txt",
    "Character layer draft. All PNGs share the source canvas. Drawing order is back to front in character.json. Pivot/tip/origin coordinates are source-image pixels. Visible pixels are original; generated/ contains accepted hidden pixels only. Review masks, anatomy and bend tests before rigging. This is not a finished skeletal runtime export.\n",
  );
  progress("Packing project ZIP…");
  return zip.generateAsync({ type: "blob" });
}
export interface CharacterSession {
  projectUrl?: string;
  source: Pixels;
  plan: CharacterPlan;
  completions: Record<string, Pixels>;
  completionKinds?: Record<string, "imported" | "generated">;
}
export async function sessionStore(value?: CharacterSession): Promise<CharacterSession | null> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("sprite-tools-character-layers", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("session");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result,
        tx = db.transaction("session", value ? "readwrite" : "readonly");
      const req = value
        ? tx.objectStore("session").put(value, "current")
        : tx.objectStore("session").get("current");
      let result: CharacterSession | null = null;
      req.onsuccess = () => {
        if (!value) result = req.result ?? null;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function importCharacterZip(file: File): Promise<CharacterSession> {
  const { checkCharacterZip, readCharacterZipFile } = await import("./zip-guard");
  if (file.size > 64 * 1024 * 1024) throw new Error("Character ZIP exceeds 64 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkCharacterZip(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const planFile = zip.file("plan.json"),
    sourceFile = zip.file("source.png");
  if (!planFile || !sourceFile) throw new Error("Character ZIP needs source.png and plan.json.");
  const { validatePlan } = await import("./types");
  let expanded = 0;
  const read = async (f: unknown, max: number) => {
    const b = await readCharacterZipFile(f, Math.min(max, 192 * 1024 * 1024 - expanded));
    expanded += b.length;
    return b;
  };
  const image = async (f: unknown) => {
    const b = await read(f, 20 * 1024 * 1024),
      url = URL.createObjectURL(new Blob([new Uint8Array(b)], { type: "image/png" }));
    try {
      return await decodeCharacterImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const text = new TextDecoder().decode(await read(planFile, 1024 * 1024));
  if (text.length > 1024 * 1024) throw new Error("Character plan exceeds 1 MB.");
  const plan = validatePlan(JSON.parse(text));
  const source = await image(sourceFile);
  if (source.width !== plan.width || source.height !== plan.height)
    throw new Error("ZIP source and plan canvases differ.");
  const completions: Record<string, Pixels> = {},
    completionKinds: Record<string, "imported" | "generated"> = {};
  const meta = zip.file("character.json");
  let kinds: Record<string, string> = {};
  if (meta) {
    const parsed = JSON.parse(new TextDecoder().decode(await read(meta, 1024 * 1024)));
    if (Array.isArray(parsed.layers))
      kinds = Object.fromEntries(
        parsed.layers.map((l: { id: string; completion: string }) => [l.id, l.completion]),
      );
  }
  for (const p of plan.parts) {
    const f = zip.file(`completions/${p.id}.png`);
    if (!f) continue;
    const im = await image(f);
    if (im.width !== plan.width || im.height !== plan.height)
      throw new Error("ZIP completion uses the wrong canvas.");
    completions[p.id] = im;
    completionKinds[p.id] = kinds[p.id] === "generated" ? "generated" : "imported";
  }
  return { source, plan, completions, completionKinds };
}

export function croppedCanvas(image: Pixels) {
  let x0 = image.width,
    y0 = image.height,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (image.data[(y * image.width + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x0 > x1) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 0;
    return { canvas, x: 0, y: 0 };
  }
  const c = document.createElement("canvas");
  c.width = x1 - x0 + 1;
  c.height = y1 - y0 + 1;
  const im = new ImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++)
    im.data.set(
      image.data.subarray(((y + y0) * image.width + x0) * 4, ((y + y0) * image.width + x1 + 1) * 4),
      y * c.width * 4,
    );
  c.getContext("2d")!.putImageData(im, 0, 0);
  return { canvas: c, x: x0, y: y0 };
}
