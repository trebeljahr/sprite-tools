// Client for the accounts server's video endpoints (packages/server). Paid video
// is disabled server-side: both endpoints answer 503 without reading the
// upload. The response shape is the one the removed Server Actions returned.

export interface GenerationStatus {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  video?: { url?: string; duration?: number };
  error?: string;
}

interface Result<T> {
  success: boolean;
  data?: T;
  id?: string;
  error?: string;
}

const UNAVAILABLE = "AI video generation is currently unavailable.";

async function call<T>(input: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(input, { ...init, cache: "no-store", credentials: "same-origin" });
    const body = (await response.json().catch(() => null)) as Result<T> | null;
    if (response.ok && body?.success) return body;
    return { success: false, error: body?.error || UNAVAILABLE };
  } catch {
    return { success: false, error: UNAVAILABLE };
  }
}

export function startVideoGeneration(formData: FormData) {
  return call<never>("/api/video/generations", { method: "POST", body: formData });
}

export function videoGenerationStatus(id: string) {
  return call<GenerationStatus>(`/api/video/generations/${encodeURIComponent(id)}`);
}
