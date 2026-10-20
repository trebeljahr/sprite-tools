// AI image generation for /generate. Two ways to pay:
//
// * Your own xAI key: the browser sends the prompt and the key straight to
//   api.x.ai (it allows cross-origin calls). The key lives only in page
//   memory and never reaches the sprite-tools server.
// * AI credit: the sprite-tools server calls xAI with its own key and takes
//   the list price plus a stated margin from a prepaid balance
//   (packages/server/src/image-generation.ts). Needs an account.

// xAI list prices, docs.x.ai/docs/models. Must match IMAGE_MODELS in
// packages/server/src/image-generation.ts (a server test compares them).
export const IMAGE_PRICING_DATE = "2026-10-20";
export const XAI_IMAGE_MODELS = [
  { id: "grok-imagine-image", label: "Grok Imagine", costUsd: 0.02 },
  { id: "grok-imagine-image-2.0", label: "Grok Imagine 2.0", costUsd: 0.04 },
] as const;

export type XaiImageModelId = (typeof XAI_IMAGE_MODELS)[number]["id"];

const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";
const OWN_KEY_TIMEOUT_MS = 90_000;

function imageMime(base64: string): string {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error = body?.error;
  if (typeof error === "string") return error;
  const nested = (error as { message?: unknown } | undefined)?.message;
  return typeof nested === "string" ? nested : fallback;
}

/** Generate one image with the visitor's own xAI key. Returns a data URL. */
export async function generateWithOwnKey(
  input: { apiKey: string; model: XaiImageModelId; prompt: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(XAI_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      n: 1,
      response_format: "b64_json",
    }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(OWN_KEY_TIMEOUT_MS),
  }).catch((error: unknown) => {
    if ((error as { name?: unknown })?.name === "TimeoutError")
      throw new Error("xAI did not answer within 90 seconds. Try again.");
    throw new Error("Could not reach xAI. Check your connection and try again.");
  });
  if (!response.ok)
    throw new Error(
      `xAI refused the request: ${await errorMessage(response, `HTTP ${response.status}`)}`,
    );
  const body = (await response.json()) as { data?: Array<{ b64_json?: unknown }> };
  const b64 = body.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new Error("xAI sent no image.");
  return `data:${imageMime(b64)};base64,${b64}`;
}

export interface CreditsInfo {
  generation: boolean;
  purchase: boolean;
  marginPercent: number;
  pricingDate: string;
  amountsUsd: number[];
  models: Array<{ id: XaiImageModelId; label: string; costUsd: number; priceUsd: number }>;
}

/** What the server offers for AI credit, or null when no server answers. */
export async function fetchCreditsInfo(
  fetchImpl: typeof fetch = fetch,
): Promise<CreditsInfo | null> {
  try {
    const response = await fetchImpl("/api/credits", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as CreditsInfo;
  } catch {
    return null;
  }
}

/** The signed-in account's AI credit in US dollars, or null when signed out. */
export async function fetchBalanceUsd(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl("/api/account", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { balanceUsd?: unknown };
    return typeof body.balanceUsd === "number" ? body.balanceUsd : null;
  } catch {
    return null;
  }
}

/** Generate one image paid from AI credit. */
export async function generateWithCredit(
  input: { model: XaiImageModelId; prompt: string; requestKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ image: string; priceUsd: number; balanceUsd: number | null }> {
  const response = await fetchImpl("/api/generate/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(await errorMessage(response, "Generation failed. Try again later."));
  return (await response.json()) as {
    image: string;
    priceUsd: number;
    balanceUsd: number | null;
  };
}

/** Start a Stripe Checkout for `amountUsd` of AI credit; returns its URL. */
export async function startCreditCheckout(
  amountUsd: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl("/api/credits/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amountUsd }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await errorMessage(response, "Checkout failed."));
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("Checkout failed.");
  return body.url;
}

/** "$0.026", "$4.97": cents for whole-cent amounts, more digits below a cent. */
export function formatUsd(value: number): string {
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) < 1e-9) return `$${(cents / 100).toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

export type SpriteTemplateType = "side-scroller" | "top-down-4" | "top-down-8" | "isometric";

export interface SpriteTemplate {
  id: SpriteTemplateType;
  name: string;
  description: string;
  basePrompt: string;
}

export const SPRITE_TEMPLATES: SpriteTemplate[] = [
  {
    id: "side-scroller",
    name: "Side-Scroller Character",
    description: "Single side-view character for 2D platformers.",
    basePrompt:
      "Side-view character design for a 2D side-scroller game, {prompt}. Full body, clean character sheet, flat vibrant colors, high contrast, centered, on a solid {bgcolor} background, sharp edges, professional game art.",
  },
  {
    id: "top-down-4",
    name: "Top-Down (4 Directions)",
    description: "Character views for North, South, East, West.",
    basePrompt:
      "Character sprite sheet showing 4 directions: front, back, left, and right views. {prompt}. Top-down perspective, grid-aligned, consistent proportions, on a solid {bgcolor} background, clean character design, game asset, flat lighting.",
  },
  {
    id: "top-down-8",
    name: "Top-Down (8 Directions)",
    description: "Character views for 8 compass directions including diagonals.",
    basePrompt:
      "Character sprite sheet showing 8 directions: north, south, east, west, northeast, northwest, southeast, southwest views. {prompt}. Top-down perspective, consistent lighting and proportions, on a solid {bgcolor} background, clean character design, game asset, professional sprite sheet.",
  },
  {
    id: "isometric",
    name: "Isometric Character",
    description: "Character design in isometric perspective.",
    basePrompt:
      "Isometric character design, {prompt}. 45 degree angle perspective, consistent with isometric tile grids, full body, clean edges, on a solid {bgcolor} background, game asset, sharp detail.",
  },
];
