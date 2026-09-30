export interface VideoGenerationOptions {
  model?: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
}

export interface GenerationResponse {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  video?: {
    url?: string;
    duration?: number;
    respect_moderation?: boolean;
  };
  model?: string;
  usage?: { cost_in_usd_ticks: number };
  progress?: number;
  error?: string;
}

// No server identity, job ownership store, or atomic cost budget exists yet.
// Keep both operations disabled until those controls are enforced server-side.
// A configured provider key or a client-side AuthWall must never enable access.
export const PAID_VIDEO_UNAVAILABLE = "AI video generation is currently unavailable.";

export async function generateVideo(
  _image64: string,
  _prompt: string,
  _options: VideoGenerationOptions = {},
): Promise<{ id: string }> {
  throw new Error(PAID_VIDEO_UNAVAILABLE);
}

export async function pollVideoStatus(_id: string): Promise<GenerationResponse> {
  throw new Error(PAID_VIDEO_UNAVAILABLE);
}
