// Hosted image generation paid from AI credit.
//
// Billing rule: you pay for an image only when it comes back, or when xAI
// does not answer at all (then it may have billed, and so do we).
//
// AI credit is a prepaid balance in US dollars, stored as integer
// micro-dollars (1,000,000 = US$1). Each image takes the provider's list
// price plus MARGIN_PERCENT from the balance. xAI bills images at a flat
// price per image, whatever the prompt, so the list price is the measured
// cost. People with their own xAI key skip all of this: the browser calls
// xAI directly and the key never reaches this server.

export const MARGIN_PERCENT = 30;
export const MICROS_PER_USD = 1_000_000;

// xAI list prices, docs.x.ai/docs/models, checked on this date. Update the
// date with the prices; the client copy in src/lib/ai-image.ts must match
// (tests/image-generation.test.ts compares them).
export const IMAGE_PRICING_DATE = "2026-10-20";
export const IMAGE_MODELS = [
  { id: "grok-imagine-image", label: "Grok Imagine", costUsd: 0.02 },
  { id: "grok-imagine-image-2.0", label: "Grok Imagine 2.0", costUsd: 0.04 },
] as const;

export type ImageModelId = (typeof IMAGE_MODELS)[number]["id"];

export const PROMPT_MAX_LENGTH = 2000;
const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";
// Cloudflare closes a proxied request after 100 s, so stay below it.
const TIMEOUT_MS = 90_000;

export function findImageModel(id: unknown) {
  return IMAGE_MODELS.find((model) => model.id === id);
}

/** Price of one image in micro-dollars: list price plus the margin, rounded up. */
export function imagePriceMicros(costUsd: number): number {
  return Math.ceil((Math.round(costUsd * MICROS_PER_USD) * (100 + MARGIN_PERCENT)) / 100);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/** xAI answered without an image, or was never reached: the price goes back. */
export class ProviderRejected extends Error {}
/** xAI did not answer in time: it may have produced and billed an image. */
export class ProviderUncertain extends Error {}

const NEVER_REACHED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function imageMime(base64: string): string {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

/** One image from xAI as a data URL. */
export async function generateXaiImage(
  apiKey: string,
  model: ImageModelId,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(XAI_IMAGES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, response_format: "b64_json" }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    if (typeof code === "string" && NEVER_REACHED.has(code))
      throw new ProviderRejected("xAI could not be reached.");
    throw new ProviderUncertain("xAI did not answer in time.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if ((error as { name?: unknown })?.name === "TimeoutError")
      throw new ProviderUncertain("xAI did not answer in time.");
    throw new ProviderRejected(`xAI sent no image (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = (body as { error?: unknown })?.error;
    const detail =
      typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? (error as { message: string }).message
          : `HTTP ${response.status}`;
    throw new ProviderRejected(`xAI refused the request: ${detail.slice(0, 300)}`);
  }
  const b64 = (body as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new ProviderRejected("xAI sent no image.");
  return `data:${imageMime(b64)};base64,${b64}`;
}
