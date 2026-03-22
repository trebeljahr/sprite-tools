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

const XAI_API_BASE = "https://api.x.ai/v1";

export async function generateVideo(
  image64: string,
  prompt: string,
  options: VideoGenerationOptions = {},
): Promise<{ id: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is not set");
  }

  const response = await fetch(`${XAI_API_BASE}/videos/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || "grok-imagine-video",
      prompt,
      image: {
        url: image64.startsWith("data:")
          ? image64
          : `data:image/jpeg;base64,${image64}`,
      },
      duration: options.duration || 1,
      resolution: options.resolution || "720p",
      aspect_ratio: options.aspect_ratio || "16:9",
    }),
  });

  console.log({ response });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`XAI API error: ${error}`);
  }

  const data = await response.json();

  console.log({ data });

  return { id: data.request_id };
}

export async function pollVideoStatus(id: string): Promise<GenerationResponse> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("XAI_API_KEY is not set");
  }

  const response = await fetch(`${XAI_API_BASE}/videos/${id}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`XAI API error: ${error}`);
  }

  return response.json();
}
