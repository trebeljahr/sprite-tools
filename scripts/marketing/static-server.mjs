// Serve the static export in out/ on a free high port, the way the
// production Worker resolves routes: /collision -> collision.html.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
};

function resolveFile(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const base = join(root, clean);
  for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Ports in the IANA ephemeral range, never a conventional dev port.
function randomPort() {
  return 49152 + Math.floor(Math.random() * (65535 - 49152));
}

export async function serveStatic(root) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = randomPort();
    const server = createServer((req, res) => {
      const file = resolveFile(root, req.url ?? "/");
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    });
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok)
      return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
  }
  throw new Error("No free port after three random attempts in 49152-65535");
}
