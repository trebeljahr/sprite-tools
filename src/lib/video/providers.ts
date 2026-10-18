import {
  MAX_VIDEO_BYTES,
  type GenerationInput,
  type ProviderId,
  validateGeneration,
} from "./schema.js";

export type ProviderTransport = typeof fetch;
export interface ProviderContext {
  transport?: ProviderTransport;
  signal?: AbortSignal;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export interface ProviderOperation {
  provider: ProviderId;
  id: string;
}
export type ProviderPoll =
  | { status: "pending" }
  | { status: "failed" }
  | { status: "done"; url: string };
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const XAI_BASE = "https://api.x.ai/v1/";
function signal(context: ProviderContext, timeout = 30_000): AbortSignal {
  const limit = AbortSignal.timeout(timeout);
  return context.signal ? AbortSignal.any([context.signal, limit]) : limit;
}
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel();
    throw new ProviderError("Provider response exceeds the local size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("Provider returned an empty response.");
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum)
        throw new ProviderError("Provider response exceeds the local size limit.");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts, total);
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      Buffer.from(await boundedBytes(response, 1024 * 1024)).toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ProviderError("Provider returned an invalid response.", true);
  }
}
function validOperation(operation: ProviderOperation): boolean {
  return operation.provider === "google"
    ? /^(?:models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9._-]{1,200}$/.test(operation.id)
    : operation.provider === "xai" && /^[a-zA-Z0-9_-]{1,200}$/.test(operation.id);
}
function apiHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  return provider === "google"
    ? { "x-goog-api-key": apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}
export function generationPayload(input: GenerationInput): Record<string, unknown> {
  const value = validateGeneration(input);
  if (value.provider === "google") {
    // Match the Gemini SDK's imageToMldev wire format for predictLongRunning.
    const image = (item: NonNullable<GenerationInput["firstFrame"]>) => ({
      bytesBase64Encoded: item.data,
      mimeType: item.mimeType,
    });
    return {
      instances: [
        {
          prompt: value.prompt,
          ...(value.firstFrame ? { image: image(value.firstFrame) } : {}),
          ...(value.lastFrame ? { lastFrame: image(value.lastFrame) } : {}),
          ...(value.referenceImages?.length
            ? {
                referenceImages: value.referenceImages.map((item) => ({
                  image: image(item),
                  referenceType: "asset",
                })),
              }
            : {}),
        },
      ],
      parameters: {
        aspectRatio: value.aspectRatio,
        durationSeconds: value.durationSeconds,
        resolution: value.resolution,
      },
    };
  }
  const image = (item: NonNullable<GenerationInput["firstFrame"]>) => ({
    url: `data:${item.mimeType};base64,${item.data}`,
  });
  return {
    model: value.model,
    prompt: value.prompt,
    duration: value.durationSeconds,
    resolution: value.resolution,
    aspect_ratio: value.aspectRatio,
    generate_audio: false,
    ...(value.firstFrame ? { image: image(value.firstFrame) } : {}),
    ...(value.lastFrame ? { last_frame: image(value.lastFrame) } : {}),
    ...(value.referenceImages?.length
      ? { reference_images: value.referenceImages.map(image) }
      : {}),
  };
}
function submissionHttpError(status: number): ProviderError {
  // Only authored guidance and the HTTP status leave this boundary. Provider
  // bodies and statusText can contain credentials, prompts, or image data.
  const guidance: Record<number, string> = {
    400: "Check the selected model, video controls, and reference images.",
    401: "Check the API key in local setup.",
    402: "Check billing and required prepayment in the provider console.",
    403: "Check model access, key permissions, and billing in the provider console.",
    404: "Check model availability and API access in the provider console.",
    429: "Check quota, rate limits, and billing in the provider console.",
  };
  const uncertain = status >= 500;
  return new ProviderError(
    uncertain
      ? `The provider could not confirm the generation request (HTTP ${status}). The reserved budget is held; check the provider console before submitting another request.`
      : `The provider declined the generation request (HTTP ${status}). ${guidance[status] ?? "Check the provider console and key permissions."}`,
    uncertain,
  );
}
export async function submitGeneration(
  input: GenerationInput,
  apiKey: string,
  context: ProviderContext = {},
): Promise<ProviderOperation> {
  const value = validateGeneration(input);
  const url =
    value.provider === "google"
      ? `${GOOGLE_BASE}models/${value.model}:predictLongRunning`
      : `${XAI_BASE}videos/generations`;
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders(value.provider, apiKey) },
      body: JSON.stringify(generationPayload(value)),
      redirect: "error",
      signal: signal(context, 90_000),
    });
  } catch {
    throw new ProviderError(
      "Submission outcome is unknown. The reserved budget is held; do not submit a duplicate.",
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw submissionHttpError(response.status);
  }
  const result = await responseJson(response);
  const id = value.provider === "google" ? result.name : result.request_id;
  if (typeof id !== "string")
    throw new ProviderError("The provider did not return a usable generation identifier.", true);
  const operation = { provider: value.provider, id };
  if (!validOperation(operation))
    throw new ProviderError("The provider returned an invalid generation identifier.", true);
  return operation;
}
export async function pollGeneration(
  operation: ProviderOperation,
  apiKey: string,
  context: ProviderContext = {},
): Promise<ProviderPoll> {
  if (!validOperation(operation)) throw new ProviderError("Invalid saved generation identifier.");
  const url =
    operation.provider === "google"
      ? `${GOOGLE_BASE}${operation.id}`
      : `${XAI_BASE}videos/${operation.id}`;
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(url, {
      headers: apiHeaders(operation.provider, apiKey),
      redirect: "error",
      signal: signal(context),
    });
  } catch {
    throw new ProviderError("Generation status is temporarily unavailable.", true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError("Generation status is temporarily unavailable.", true);
  }
  const data = await responseJson(response);
  if (operation.provider === "google") {
    if (!data.done) return { status: "pending" };
    if (data.error) return { status: "failed" };
    const output = data.response as
      | { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } }
      | undefined;
    const url = output?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (typeof url !== "string") return { status: "failed" };
    return { status: "done", url };
  }
  if (data.status === "pending" || data.status === "processing") return { status: "pending" };
  if (data.status === "failed" || data.status === "expired") return { status: "failed" };
  const video = data.video as { url?: string; respect_moderation?: boolean } | undefined;
  if (
    data.status === "done" &&
    video?.respect_moderation !== false &&
    typeof video?.url === "string"
  )
    return { status: "done", url: video.url };
  throw new ProviderError("Provider returned an invalid generation status.", true);
}
export function validateDownloadUrl(provider: ProviderId, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("Provider returned an invalid download address.");
  }
  const allowed =
    provider === "google"
      ? url.hostname === "generativelanguage.googleapis.com" ||
        url.hostname === "storage.googleapis.com" ||
        url.hostname.endsWith(".googleusercontent.com")
      : url.hostname === "vidgen.x.ai" ||
        url.hostname.endsWith(".vidgen.x.ai") ||
        url.hostname === "media.x.ai";
  if (
    !allowed ||
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ProviderError("Provider download address is not permitted.");
  return url;
}
export async function downloadVideo(
  provider: ProviderId,
  raw: string,
  apiKey: string,
  context: ProviderContext = {},
): Promise<Uint8Array> {
  let url = validateDownloadUrl(provider, raw);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const response = await (context.transport ?? fetch)(url.toString(), {
        headers:
          provider === "google" && url.hostname === "generativelanguage.googleapis.com"
            ? { "x-goog-api-key": apiKey }
            : {},
        redirect: "manual",
        signal: signal(context, 120_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new ProviderError("Provider download redirect is invalid.");
        url = validateDownloadUrl(provider, new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError("Generated video could not be downloaded.");
      }
      const type = response.headers.get("content-type")?.split(";")[0];
      if (
        type &&
        !["video/mp4", "application/octet-stream", "binary/octet-stream"].includes(type)
      ) {
        await response.body?.cancel();
        throw new ProviderError("Provider did not return an MP4 video.");
      }
      const bytes = await boundedBytes(response, MAX_VIDEO_BYTES);
      if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp")
        throw new ProviderError("Provider did not return an MP4 video.");
      return bytes;
    }
    throw new ProviderError("Too many provider download redirects.");
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Generated video could not be downloaded.");
  }
}
