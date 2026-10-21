/** Explicit project links load only local-to-this-site files, with bounded transfer sizes. */
export function sameOriginFile(path: string, base: string) {
  const origin = new URL(base),
    url = new URL(path, origin);
  if (
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw Error("Choose a project file hosted on this same site.");
  return url.href;
}
export async function boundedFile(
  url: string,
  limit: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(60000);
  const r = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: "same-origin",
    redirect: "error",
  });
  if (!r.ok) throw Error(`Project file could not be loaded (HTTP ${r.status}).`);
  if (Number(r.headers.get("content-length")) > limit) {
    await r.body?.cancel();
    throw Error("Project file is too large.");
  }
  const reader = r.body?.getReader();
  if (!reader) throw Error("Project file is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("Project file is too large.");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
