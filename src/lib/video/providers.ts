import { createHash } from "node:crypto";
import {
  GOOGLE_OMNI_GATE_MESSAGE,
  GOOGLE_OMNI_MAX_INPUT_TOKENS,
  GOOGLE_OMNI_MAX_OUTPUT_TOKENS,
  GOOGLE_OMNI_MODEL,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_MODELS,
  type GenerationInput,
  type ProviderId,
  validateGeneration,
  isBase64,
} from "./schema.js";

export type ProviderTransport = typeof fetch;
export interface ProviderContext {
  transport?: ProviderTransport;
  signal?: AbortSignal;
  enableGoogleOmni?: boolean;
  omniPreflight?: OmniPreflight;
}
export interface OmniPreflight {
  inputTokens: number;
  requestDigest: string;
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
  kind?: "interaction";
}
export type ProviderPoll =
  | { status: "pending" }
  | { status: "failed" }
  | { status: "done"; url: string; downloadKind?: "omni" }
  | { status: "done"; bytes: Uint8Array };
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const XAI_BASE = "https://api.x.ai/v1/";
// A REST interaction may echo both input images alongside an inline MP4.
const OMNI_MAX_RESPONSE_BYTES =
  Math.ceil((MAX_VIDEO_BYTES + 2 * MAX_IMAGE_BYTES) / 3) * 4 + 1024 * 1024;
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
async function responseJson(
  response: Response,
  maximum = 1024 * 1024,
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(Buffer.from(await boundedBytes(response, maximum)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ProviderError("Provider returned an invalid response.", true);
  }
}
function validOperation(operation: ProviderOperation): boolean {
  if (operation.kind === "interaction")
    return operation.provider === "google" && /^v1_[a-zA-Z0-9_-]{1,512}$/.test(operation.id);
  if (operation.kind !== undefined) return false;
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
  if (value.model === GOOGLE_OMNI_MODEL) {
    return {
      model: GOOGLE_OMNI_MODEL,
      input: omniInput(value),
      background: true,
      store: true,
      service_tier: "standard",
      generation_config: {
        max_output_tokens: GOOGLE_OMNI_MAX_OUTPUT_TOKENS,
        video_config: { task: value.firstFrame ? "image_to_video" : "text_to_video" },
      },
      response_format: {
        type: "video",
        resolution: "720p",
        aspect_ratio: value.aspectRatio,
        duration: "3s",
        delivery: "uri",
      },
    };
  }
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
function omniInput(value: GenerationInput) {
  const instruction = value.lastFrame
    ? "Use the first supplied image as the starting frame and the second as the ending frame.\n"
    : value.firstFrame
      ? "Use the supplied image as the starting frame.\n"
      : "";
  return [
    ...[value.firstFrame, value.lastFrame]
      .filter((image) => image !== undefined)
      .map((image) => ({ type: "image" as const, mime_type: image.mimeType, data: image.data })),
    { type: "text" as const, text: instruction + value.prompt },
  ];
}
function omniRequestDigest(value: GenerationInput): string {
  return createHash("sha256")
    .update(JSON.stringify(generationPayload(value)))
    .digest("hex");
}
/** Count the exact final text/images with this model before any paid reservation or submit. */
export async function preflightGoogleOmni(
  input: GenerationInput,
  apiKey: string,
  context: ProviderContext = {},
): Promise<OmniPreflight> {
  const value = validateGeneration(input);
  if (value.model !== GOOGLE_OMNI_MODEL)
    throw new ProviderError("Choose Gemini Omni for this input-token check.");
  const parts = omniInput(value).map((item) =>
    item.type === "image"
      ? { inlineData: { mimeType: item.mime_type, data: item.data } }
      : { text: item.text },
  );
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(
      `${GOOGLE_BASE}models/${GOOGLE_OMNI_MODEL}:countTokens`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders("google", apiKey) },
        body: JSON.stringify({ contents: [{ role: "user", parts }] }),
        redirect: "error",
        signal: signal(context),
      },
    );
  } catch {
    throw new ProviderError("Omni input-token check failed. No generation was submitted.");
  }
  if (!response.ok) {
    const hint = await responseDiagnostic("google", response);
    throw new ProviderError(
      `Omni input-token check failed (HTTP ${response.status}). ${hint ?? "Check model access and token-count support."} No generation was submitted.`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = await responseJson(response, 16 * 1024);
  } catch {
    throw new ProviderError(
      "Omni returned an invalid input-token count. No generation was submitted.",
    );
  }
  if (
    !Number.isSafeInteger(data.totalTokens) ||
    (data.totalTokens as number) < 1 ||
    (data.totalTokens as number) > GOOGLE_OMNI_MAX_INPUT_TOKENS
  )
    throw new ProviderError(
      "Omni requires a verified input count of 1–10,000 tokens. Shorten the prompt or references. No generation was submitted.",
    );
  return { inputTokens: data.totalTokens as number, requestDigest: omniRequestDigest(value) };
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
): Promise<{ available: true; supportsGeneration: boolean | null; note?: string }> {
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
  if (model === GOOGLE_OMNI_MODEL)
    return {
      available: true,
      supportsGeneration: null,
      note: "Model metadata is available. This does not verify Interactions video generation, billing, or account entitlement.",
    };
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
  const omni = value.model === GOOGLE_OMNI_MODEL;
  if (omni) {
    if (!context.enableGoogleOmni) throw new ProviderError(GOOGLE_OMNI_GATE_MESSAGE);
    const preflight = context.omniPreflight ?? (await preflightGoogleOmni(value, apiKey, context));
    if (
      !Number.isSafeInteger(preflight.inputTokens) ||
      preflight.inputTokens < 1 ||
      preflight.inputTokens > GOOGLE_OMNI_MAX_INPUT_TOKENS ||
      preflight.requestDigest !== omniRequestDigest(value)
    )
      throw new ProviderError(
        "Omni input-token preflight does not match this request. No generation was submitted.",
      );
  }
  const url = omni
    ? `${GOOGLE_BASE}interactions`
    : value.provider === "google"
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
  const result = await responseJson(response, omni ? OMNI_MAX_RESPONSE_BYTES : undefined);
  const id = omni ? result.id : value.provider === "google" ? result.name : result.request_id;
  if (typeof id !== "string")
    throw new ProviderError("The provider did not return a usable generation identifier.", true);
  const operation: ProviderOperation = {
    provider: value.provider,
    id,
    ...(omni ? { kind: "interaction" as const } : {}),
  };
  if (!validOperation(operation))
    throw new ProviderError("The provider returned an invalid generation identifier.", true);
  // Persist a valid interaction ID even if the remaining submit payload is incomplete.
  // The next GET verifies its model/object and reads media without another paid POST.
  return operation;
}
export async function pollGeneration(
  operation: ProviderOperation,
  apiKey: string,
  context: ProviderContext = {},
): Promise<ProviderPoll> {
  if (!validOperation(operation)) throw new ProviderError("Invalid saved generation identifier.");
  const url =
    operation.kind === "interaction"
      ? `${GOOGLE_BASE}interactions/${operation.id}`
      : operation.provider === "google"
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
  const data = await responseJson(
    response,
    operation.kind === "interaction" ? OMNI_MAX_RESPONSE_BYTES : undefined,
  );
  if (operation.kind === "interaction") return pollOmniOutput(operation, data, apiKey, context);
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
/** Omni authenticates only the documented Google Files download endpoint. */
export function validateOmniDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("Google returned an invalid video file address.");
  }
  if (
    url.origin !== "https://generativelanguage.googleapis.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/v1beta\/files\/[a-zA-Z0-9_-]{1,200}:download$/.test(url.pathname) ||
    url.search !== "?alt=media"
  )
    throw new ProviderError("Google video file address is not permitted.");
  return url;
}
function mp4Bytes(bytes: Uint8Array): Uint8Array {
  if (
    bytes.length < 12 ||
    bytes.length > MAX_VIDEO_BYTES ||
    Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp"
  )
    throw new ProviderError("Google did not return a valid MP4 video.");
  return bytes;
}
async function pollOmniOutput(
  operation: ProviderOperation,
  data: Record<string, unknown>,
  apiKey: string,
  context: ProviderContext,
): Promise<ProviderPoll> {
  if (data.id !== operation.id || data.model !== GOOGLE_OMNI_MODEL || data.object !== "interaction")
    throw new ProviderError("Google returned an unexpected interaction status.", true);
  if (data.status === "queued" || data.status === "in_progress") return { status: "pending" };
  if (["failed", "cancelled", "incomplete", "requires_action"].includes(String(data.status)))
    return { status: "failed" };
  if (data.status !== "completed" || !Array.isArray(data.steps))
    throw new ProviderError("Google returned an invalid interaction status.", true);
  const videos = data.steps.flatMap((step) => {
    const value = record(step);
    return value?.type === "model_output" && Array.isArray(value.content)
      ? value.content.map(record).filter((item) => item?.type === "video")
      : [];
  });
  if (videos.length !== 1 || videos[0]?.mime_type !== "video/mp4")
    throw new ProviderError("Google did not return one MP4 video.", true);
  const video = videos[0]!;
  if (typeof video.data === "string") {
    if (video.data.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4 || !isBase64(video.data))
      throw new ProviderError("Google inline video exceeds the size limit or is invalid.", true);
    return { status: "done", bytes: mp4Bytes(Buffer.from(video.data, "base64")) };
  }
  if (typeof video.uri !== "string")
    throw new ProviderError("Google returned no usable video output.", true);
  const url = validateOmniDownloadUrl(video.uri);
  const name = url.pathname.slice("/v1beta/".length, -":download".length);
  let response: Response;
  try {
    response = await (context.transport ?? fetch)(`${GOOGLE_BASE}${name}`, {
      method: "GET",
      headers: apiHeaders("google", apiKey),
      redirect: "error",
      signal: signal(context),
    });
  } catch {
    throw new ProviderError("Google video file status is temporarily unavailable.", true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError("Google video file status is temporarily unavailable.", true);
  }
  const file = await responseJson(response, 16 * 1024);
  if (file.name !== name || file.mimeType !== "video/mp4")
    throw new ProviderError("Google returned invalid video file metadata.", true);
  if (file.state === "PROCESSING") return { status: "pending" };
  if (file.state === "FAILED") return { status: "failed" };
  if (file.state !== "ACTIVE")
    throw new ProviderError("Google returned invalid video file readiness.", true);
  return { status: "done", url: url.toString(), downloadKind: "omni" };
}
export async function downloadOmniVideo(
  raw: string,
  apiKey: string,
  context: ProviderContext = {},
): Promise<Uint8Array> {
  const url = validateOmniDownloadUrl(raw);
  try {
    const response = await (context.transport ?? fetch)(url.toString(), {
      method: "GET",
      headers: apiHeaders("google", apiKey),
      redirect: "error",
      signal: signal(context, 120_000),
    });
    if (
      !response.ok ||
      response.headers.get("content-type")?.split(";")[0].trim() !== "video/mp4"
    ) {
      await response.body?.cancel();
      throw new ProviderError("Google did not return an MP4 video download.", true);
    }
    return mp4Bytes(await boundedBytes(response, MAX_VIDEO_BYTES));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Google video download is temporarily unavailable.", true);
  }
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
