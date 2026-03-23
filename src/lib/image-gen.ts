export interface ImageGenerationOptions {
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
  nologo?: boolean;
  enhance?: boolean;
}

export const POLLINATIONS_MODELS = [
  "flux",
  "flux-realism",
  "flux-anime",
  "flux-3d",
  "flux-pro",
  "any-dark",
  "flux-pixel",
];

export async function generateImage(
  prompt: string,
  options: ImageGenerationOptions = {}
): Promise<string> {
  const {
    model = "flux",
    width = 1024,
    height = 1024,
    seed = Math.floor(Math.random() * 1000000),
    nologo = true,
    enhance = false,
  } = options;

  const params = new URLSearchParams({
    prompt: prompt,
    model: model,
    width: width.toString(),
    height: height.toString(),
    seed: seed.toString(),
    nologo: nologo.toString(),
    enhance: enhance.toString(),
  });

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
  
  // We can just return the URL since Pollinations returns the image directly
  // or we can fetch it to verify or get base64.
  // Returning the URL is simplest for immediate preview.
  return url;
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
    basePrompt: "Side-view character design for a 2D side-scroller game, {prompt}. Full body, clean character sheet, flat vibrant colors, high contrast, centered, on a solid {bgcolor} background, sharp edges, professional game art.",
  },
  {
    id: "top-down-4",
    name: "Top-Down (4 Directions)",
    description: "Character views for North, South, East, West.",
    basePrompt: "Character sprite sheet showing 4 directions: front, back, left, and right views. {prompt}. Top-down perspective, grid-aligned, consistent proportions, on a solid {bgcolor} background, clean character design, game asset, flat lighting.",
  },
  {
    id: "top-down-8",
    name: "Top-Down (8 Directions)",
    description: "Character views for 8 compass directions including diagonals.",
    basePrompt: "Character sprite sheet showing 8 directions: north, south, east, west, northeast, northwest, southeast, southwest views. {prompt}. Top-down perspective, consistent lighting and proportions, on a solid {bgcolor} background, clean character design, game asset, professional sprite sheet.",
  },
  {
    id: "isometric",
    name: "Isometric Character",
    description: "Character design in isometric perspective.",
    basePrompt: "Isometric character design, {prompt}. 45 degree angle perspective, consistent with isometric tile grids, full body, clean edges, on a solid {bgcolor} background, game asset, sharp detail.",
  }
];
