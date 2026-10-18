import type { GenerationInput, ProcessingOptions, PublicJob, StudioStatus } from "./schema";
export type { StudioStatus } from "./schema";
export type StudioJob = PublicJob;

export const STUDIO_TOKEN_KEY = "sprite-tools:studio-token";

/** The hosted site never contacts arbitrary local origins or handles provider keys. */
export function isLocalStudio(): boolean {
  return typeof window !== "undefined" && window.location.hostname === "127.0.0.1";
}

function headers(): HeadersInit {
  if (!isLocalStudio()) throw new Error("Open Video Studio using the local companion URL.");
  const token = sessionStorage.getItem(STUDIO_TOKEN_KEY);
  if (!token) throw new Error("Open the setup link printed by sprite-tools studio first.");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/studio${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(typeof value.error === "string" ? value.error : "Local video request failed.");
  return value as T;
}

export const studioStatus = () => request<StudioStatus>("/status");
export const studioJob = (id: string) => request<StudioJob>(`/jobs/${encodeURIComponent(id)}`);
export const generateStudioVideo = (
  requestId: string,
  generation: GenerationInput,
  processing: ProcessingOptions,
) => request<StudioJob>("/jobs", { requestId, generation, processing });
export const importStudioVideo = (
  requestId: string,
  fileName: string,
  videoBase64: string,
  processing: ProcessingOptions,
) => request<StudioJob>("/import", { requestId, fileName, videoBase64, processing });
export const retryStudioProcessing = (id: string, processing: ProcessingOptions) =>
  request<StudioJob>(`/jobs/${encodeURIComponent(id)}/retry-processing`, { processing });
export const closeUncertainStudioJob = (id: string) =>
  request<StudioJob>(`/jobs/${encodeURIComponent(id)}/resolve-uncertain`, { acknowledge: true });

export async function studioArtifact(
  id: string,
  name: "video.mp4" | "sheet.png" | "metadata.json",
): Promise<Blob> {
  const response = await fetch(`/api/studio/jobs/${encodeURIComponent(id)}/files/${name}`, {
    headers: headers(),
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Could not read this local output.");
  return response.blob();
}

export function fileBase64(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes)
    return Promise.reject(new Error(`File must be smaller than ${maxBytes / 1024 / 1024} MB.`));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
