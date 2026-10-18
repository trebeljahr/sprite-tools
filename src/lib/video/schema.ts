import { z } from "zod";

export type ProviderId = "google" | "xai";
export type VideoResolution = "480p" | "720p" | "1080p";
export const VIDEO_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "google", label: "Google Veo" },
  { id: "xai", label: "xAI Grok Imagine" },
];
export interface VideoModel {
  id: string;
  provider: ProviderId;
  label: string;
  minDuration: number;
  maxDuration: number;
  durations?: number[];
  resolutions: VideoResolution[];
  aspectRatios: string[];
  maxReferenceImages: number;
  supportsFirstFrame: boolean;
  supportsLastFrame: boolean;
  pricePerSecondUsd: Partial<Record<VideoResolution, number>>;
  inputImageUsd: number;
}
const google = {
  provider: "google" as const,
  minDuration: 4,
  maxDuration: 8,
  durations: [4, 6, 8],
  resolutions: ["720p", "1080p"] as VideoResolution[],
  aspectRatios: ["16:9", "9:16"],
  supportsFirstFrame: true,
  supportsLastFrame: true,
  inputImageUsd: 0,
};
const xai = {
  provider: "xai" as const,
  minDuration: 1,
  maxDuration: 15,
  resolutions: ["480p", "720p", "1080p"] as VideoResolution[],
  aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:2"],
  supportsFirstFrame: true,
  inputImageUsd: 0.01,
};
// List prices checked against the official provider pricing pages on 2026-10-18.
// Estimates are locally reserved ceilings, not a provider billing reconciliation.
export const VIDEO_PRICING_DATE = "2026-10-18";
export const VIDEO_MODELS: VideoModel[] = [
  {
    ...google,
    id: "veo-3.1-fast-generate-preview",
    label: "Veo 3.1 Fast",
    maxReferenceImages: 3,
    pricePerSecondUsd: { "720p": 0.1, "1080p": 0.12 },
  },
  {
    ...google,
    id: "veo-3.1-lite-generate-preview",
    label: "Veo 3.1 Lite",
    maxReferenceImages: 0,
    pricePerSecondUsd: { "720p": 0.05, "1080p": 0.08 },
  },
  {
    ...google,
    id: "veo-3.1-generate-preview",
    label: "Veo 3.1",
    maxReferenceImages: 3,
    pricePerSecondUsd: { "720p": 0.4, "1080p": 0.4 },
  },
  {
    ...xai,
    id: "grok-imagine-video-1.5-lite",
    label: "Grok Imagine 1.5 Lite",
    maxReferenceImages: 0,
    supportsLastFrame: false,
    pricePerSecondUsd: { "480p": 0.02, "720p": 0.03, "1080p": 0.14 },
  },
  {
    ...xai,
    id: "grok-imagine-video-1.5",
    label: "Grok Imagine 1.5",
    maxReferenceImages: 14,
    supportsLastFrame: true,
    pricePerSecondUsd: { "480p": 0.08, "720p": 0.14, "1080p": 0.25 },
  },
  {
    ...xai,
    id: "grok-imagine-video",
    label: "Grok Imagine Classic",
    maxReferenceImages: 7,
    supportsLastFrame: false,
    resolutions: ["480p", "720p"],
    inputImageUsd: 0.002,
    pricePerSecondUsd: { "480p": 0.05, "720p": 0.07 },
  },
];
export function getVideoModel(id: string): VideoModel {
  const model = VIDEO_MODELS.find((item) => item.id === id);
  if (!model) throw new Error("Choose a supported video model.");
  return model;
}
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 24 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export function isBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding === -1 || (padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}
const imageSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg"]),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      .refine(isBase64),
  })
  .strict();
export const generationInputSchema = z
  .object({
    provider: z.enum(["google", "xai"]),
    model: z.string().max(100),
    prompt: z.string().trim().min(1).max(8000),
    durationSeconds: z.number().int().min(1).max(15),
    resolution: z.enum(["480p", "720p", "1080p"]),
    aspectRatio: z.string().max(8),
    firstFrame: imageSchema.optional(),
    lastFrame: imageSchema.optional(),
    referenceImages: z.array(imageSchema).max(14).optional(),
  })
  .strict();
export type GenerationInput = z.infer<typeof generationInputSchema>;
export const processingOptionsSchema = z
  .object({
    fps: z.number().min(1).max(24).default(8),
    startSeconds: z.number().min(0).max(30).default(0),
    endSeconds: z.number().positive().max(30).optional(),
    loopMode: z.enum(["full", "auto"]).default("full"),
    loopMinSeconds: z.number().min(0.1).max(30).default(0.4),
    loopMaxSeconds: z.number().min(0.1).max(30).default(2),
    maxFrames: z.number().int().min(2).max(120).optional(),
    dedupeThreshold: z.number().min(0).max(8).optional(),
    frameWidth: z.number().int().min(16).max(512).default(128),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#00ff00"),
    tolerance: z.number().int().min(0).max(255).default(40),
    softness: z.number().min(0).max(100).default(20),
    spill: z.number().min(0).max(150).default(80),
    choke: z.number().int().min(0).max(5).default(1),
    columns: z.number().int().min(1).max(32).default(8),
    padding: z.number().int().min(0).max(32).default(2),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9 _-]+$/)
      .default("animation"),
  })
  .strict();
export type ProcessingOptions = z.infer<typeof processingOptionsSchema>;
export type ProcessingInput = z.input<typeof processingOptionsSchema>;
export function validateProcessing(input: unknown): ProcessingOptions {
  const result = processingOptionsSchema.safeParse(input ?? {});
  if (!result.success) throw new Error("Invalid sprite processing settings.");
  if (result.data.endSeconds !== undefined && result.data.endSeconds <= result.data.startSeconds)
    throw new Error("Trim end must be later than trim start.");
  if (result.data.loopMinSeconds > result.data.loopMaxSeconds)
    throw new Error("Minimum loop duration must not exceed maximum loop duration.");
  return result.data;
}
export function validateGeneration(input: unknown): GenerationInput {
  const parsed = generationInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid generation settings or reference image.");
  const value = parsed.data;
  const model = getVideoModel(value.model);
  if (value.provider !== model.provider)
    throw new Error("The model does not belong to this provider.");
  if (!model.resolutions.includes(value.resolution))
    throw new Error("This model does not support that resolution.");
  if (!model.aspectRatios.includes(value.aspectRatio))
    throw new Error("This model does not support that aspect ratio.");
  if (
    value.durationSeconds < model.minDuration ||
    value.durationSeconds > model.maxDuration ||
    (model.durations && !model.durations.includes(value.durationSeconds))
  )
    throw new Error("This model does not support that duration.");
  const references = value.referenceImages ?? [];
  if (references.length > model.maxReferenceImages)
    throw new Error("Too many reference images for this model.");
  if (value.lastFrame && !model.supportsLastFrame)
    throw new Error("This model does not support an end frame.");
  if (value.provider === "google") {
    if (value.lastFrame && !value.firstFrame)
      throw new Error("Google end frames require a start frame.");
    if (references.length && (value.firstFrame || value.lastFrame))
      throw new Error("Choose reference images or start/end frames for Google.");
    if ((references.length || value.resolution === "1080p") && value.durationSeconds !== 8)
      throw new Error("Google reference images and 1080p require 8 seconds.");
  } else {
    if ((references.length || value.lastFrame) && value.resolution === "1080p")
      throw new Error("Grok reference images and end frames support up to 720p.");
    if (value.model === "grok-imagine-video" && references.length) {
      if (value.firstFrame)
        throw new Error("Classic Grok cannot combine a start frame and references.");
      if (value.durationSeconds > 10)
        throw new Error("Classic Grok references support up to 10 seconds.");
    }
  }
  const images = [value.firstFrame, value.lastFrame, ...references].filter(
    (item) => item !== undefined,
  );
  let total = 0;
  for (const image of images) {
    const bytes =
      (image.data.length / 4) * 3 -
      (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error("Each reference image must be at most 8 MiB.");
    total += bytes;
    if (
      !(image.mimeType === "image/png"
        ? image.data.startsWith("iVBORw0KGgo")
        : image.data.startsWith("/9j/"))
    )
      throw new Error("Reference image content does not match its PNG or JPEG type.");
  }
  if (total > MAX_REFERENCE_BYTES)
    throw new Error("Reference images exceed the 24 MiB combined limit.");
  return value;
}
export function estimateUsd(input: GenerationInput): number {
  const value = validateGeneration(input);
  const model = getVideoModel(value.model);
  const images =
    Number(Boolean(value.firstFrame)) +
    Number(Boolean(value.lastFrame)) +
    (value.referenceImages?.length ?? 0);
  const durationMicros =
    Math.round((model.pricePerSecondUsd[value.resolution] ?? 0) * 1_000_000) *
    value.durationSeconds;
  const imageMicros = Math.round(model.inputImageUsd * 1_000_000) * images;
  return (durationMicros + imageMicros) / 1_000_000;
}
export type JobStatus = "queued" | "generating" | "processing" | "done" | "failed" | "uncertain";
export interface PublicJob {
  id: string;
  status: JobStatus;
  reservedUsd: number;
  /** Increases after each successful processing run, including reprocessing through MCP. */
  outputRevision: number;
  /** Saved non-secret output controls; selecting a job restores these settings. */
  processing: ProcessingOptions;
  error?: string;
  artifacts?: { videoPath: string; sheetPath: string; metadataPath: string };
}
export interface StudioStatus {
  simulation: boolean;
  locked: boolean;
  providers: { id: ProviderId; configured: boolean }[];
  budget: { limitUsd: number; perJobUsd: number; committedUsd: number; remainingUsd: number };
  jobs: PublicJob[];
}
export const artifactNames = ["video.mp4", "sheet.png", "metadata.json"] as const;
export type ArtifactName = (typeof artifactNames)[number];
