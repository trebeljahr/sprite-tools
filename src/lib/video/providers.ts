import {
  MAX_VIDEO_BYTES,
  VIDEO_MODELS,
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
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const GOOGLE_ERROR_REASONS = new Map<string, string>([
  ["API_KEY_INVALID", "Google rejected the API key. Check the key in local setup."],
  ["API_KEY_SERVICE_BLOCKED", "The API key's service restrictions block the Gemini API."],
  [
    "API_KEY_HTTP_REFERRER_BLOCKED",
    "The API key's website restrictions block requests from this local server.",
  ],
  ["API_KEY_IP_ADDRESS_BLOCKED", "The API key's IP address restrictions block this server."],
  ["SERVICE_DISABLED", "Enable the Gemini API for the key's existing Google project."],
  ["BILLING_DISABLED", "Check billing and required prepayment for the key's Google project."],
]);
/** Classifies untrusted errors without returning any provider-authored text. */
export function classifyProviderError(provider: ProviderId, payload: unknown): string | undefined {
  if (provider !== "google") return undefined;
  const error = record(record(payload)?.error);
  if (!error) return undefined;
  if (Array.isArray(error.details)) {
    for (const item of error.details) {
      const detail = record(item);
      if (
        detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
        typeof detail.reason === "string"
      ) {
        const hint = GOOGLE_ERROR_REASONS.get(detail.reason);
        if (hint) return hint;
      }
    }
  }
  if (typeof error.message !== "string" || error.message.length > 4096) return undefined;
  const message = error.message;
  if (/^api key (?:not valid|is invalid|is not valid|expired)/i.test(message))
    return "Google rejected the API key. Check the key in local setup.";
  if (/^(?:your )?prepayment credits (?:are depleted|are exhausted)/i.test(message))
    return "Google requires a positive Gemini API prepay balance. Check AI Studio billing.";
  if (
    /^(?:billing (?:is |has been )?(?:disabled|not enabled)|this api method requires billing)/i.test(
      message,
    )
  )
    return "Check billing and required prepayment for the key's Google project.";
  if (/^your use case is currently not supported\b/i.test(message))
    return "Google does not support this combination of model, duration, and reference frames. Check those controls before submitting again.";
  if (
    /(?:last[_ ]?frame|first and last frames|interpolation)/i.test(message) &&
    /\b8\s*(?:s\b|seconds?\b)/i.test(message) &&
    /\b(?:only|must|required|requires)\b/i.test(message)
  )
    return "Google requires 8 seconds for the requested first and last frame mode.";
  if (/^invalid json payload received\b|^unknown (?:name|field)\b/i.test(message))
    return "Google rejected a request field. Check the video adapter's request format.";
  if (
    /(?:inlineData|bytesBase64Encoded|mimeType|lastFrame)/i.test(message) &&
    /(?:not supported|isn't supported|invalid|unknown)/i.test(message)
  )
    return "Google rejected an image field. Check the video adapter's image payload format.";
  if (
    /^(?:invalid image|unable to (?:decode|process|read) (?:the )?(?:input )?image|image (?:is invalid|could not be decoded))/i.test(
      message,
    )
  )
    return "Google could not read a reference image. Use a valid PNG or JPEG image.";
  if (
    /\bresolution\b/i.test(message) &&
    /(?:not supported|unsupported|invalid|must be)/i.test(message)
  )
    return "Google rejected the requested resolution. Check the model's resolution and duration limits.";
  if (
    /\b(?:duration|durationSeconds)\b/i.test(message) &&
    /(?:not supported|unsupported|invalid|must be)/i.test(message)
  )
    return "Google rejected the requested duration. Check the model's duration and reference frame limits.";
  return undefined;
}
async function responseDiagnostic(
  provider: ProviderId,
  response: Response,
): Promise<string | undefined> {
  try {
    if (provider !== "google") {
      await response.body?.cancel();
      return undefined;
    }
    const payload: unknown = JSON.parse(
      Buffer.from(await boundedBytes(response, 16 * 1024)).toString("utf8"),
    );
    return classifyProviderError(provider, payload);
  } catch {
    return undefined;
  }
}
function providerHttpError(status: number, hint?: string, modelCheck = false): ProviderError {
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
  if (modelCheck)
    return new ProviderError(
      `Google model access check failed (HTTP ${status}). ${hint ?? guidance[status] ?? "Check the provider console and key permissions."}`,
      uncertain,
    );
  return new ProviderError(
    uncertain
      ? `The provider could not confirm the generation request (HTTP ${status}). The reserved budget is held; check the provider console before submitting another request.`
      : `The provider declined the generation request (HTTP ${status}). ${hint ?? guidance[status] ?? "Check the provider console and key permissions."}`,
    uncertain,
  );
}
/** Reads model metadata; success does not confirm billing or generation entitlement. */
export async function verifyGoogleModel(
  model: string,
  apiKey: string,
  context: ProviderContext = {},
): Promise<{ available: true; supportsGeneration: boolean }> {
  if (!VIDEO_MODELS.some((item) => item.provider === "google" && item.id === model))
    throw new ProviderError("Choose a supported Google video model.");
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(`${GOOGLE_BASE}models/${model}`, {
      method: "GET",
      headers: apiHeaders("google", apiKey),
      redirect: "error",
      signal: signal(context),
    });
  } catch {
    throw new ProviderError("Google model access check is temporarily unavailable.", true);
  }
  if (!response.ok)
    throw providerHttpError(response.status, await responseDiagnostic("google", response), true);
  const result = await responseJson(response);
  if (result.name !== `models/${model}`)
    throw new ProviderError("Google returned invalid model metadata.");
  const methods = result.supportedGenerationMethods;
  return {
    available: true,
    supportsGeneration:
      Array.isArray(methods) &&
      methods.every((method) => typeof method === "string") &&
      methods.includes("predictLongRunning"),
  };
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
    throw providerHttpError(response.status, await responseDiagnostic(value.provider, response));
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
