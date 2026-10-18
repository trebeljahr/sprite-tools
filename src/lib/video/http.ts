import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { createVideoService, type VideoServiceOptions } from "./service.js";
import { MAX_VIDEO_BYTES, type GenerationInput, type ProcessingInput } from "./schema.js";
import { setupHtml } from "./setup.js";
import { writePrivateJson } from "./vault.js";

export interface StudioOptions extends VideoServiceOptions {
  port?: number;
  webRoot?: string;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const jsonLimit = 1024 * 1024;
const secureHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...secureHeaders, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function safeError(error: unknown): string {
  if (!(error instanceof Error) || /[\r\n]/.test(error.message) || error.message.length > 400)
    return "Local studio request failed.";
  // Filesystem, parsing and dependency diagnostics must not reveal request bodies.
  if ("code" in error || error instanceof SyntaxError || error instanceof z.ZodError)
    return "Local studio request failed.";
  return error.message;
}
async function body(req: IncomingMessage, maximum = jsonLimit): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new HttpError(415, "Send an application/json body.");
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length) && length > maximum)
    throw new HttpError(413, "Request body exceeds the local size limit.");
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const part of req) {
      total += part.length;
      if (total > maximum) {
        req.pause();
        throw new HttpError(413, "Request body exceeds the local size limit.");
      }
      parts.push(part);
    }
    const parsed = JSON.parse(Buffer.concat(parts, total).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON request body.");
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "Invalid request fields.");
  return result.data;
}
function nested(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
export async function startStudio(options: StudioOptions = {}) {
  const service = await createVideoService(options);
  const token = randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(`Bearer ${token}`);
  let webRoot: string | undefined;
  try {
    if (options.webRoot) {
      webRoot = await realpath(resolve(options.webRoot));
      if (!(await stat(webRoot)).isDirectory())
        throw new Error("The web export directory does not exist.");
      if (nested(webRoot, await realpath(service.stateDir)))
        throw new Error("Private studio storage must be outside the served web directory.");
    }
  } catch (error) {
    await service.close();
    throw error;
  }
  let origin = "";
  let stopping = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (stopping) throw new HttpError(503, "Local studio is stopping.");
      const expectedHost = new URL(origin).host;
      const hosts = req.rawHeaders.filter(
        (_, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === "host",
      );
      if (hosts.length !== 1 || req.headers.host !== expectedHost)
        throw new HttpError(403, "This studio accepts its exact loopback host only.");
      if (req.headers.origin !== undefined && req.headers.origin !== origin)
        throw new HttpError(403, "Cross-origin studio requests are not allowed.");
      if (!req.url?.startsWith("/") || req.url.startsWith("//"))
        throw new HttpError(400, "Invalid local request path.");
      const url = new URL(req.url, origin);
      const isApiPath = url.pathname === "/api" || url.pathname.startsWith("/api/");
      const safeDocumentNavigation =
        req.method === "GET" &&
        req.headers["sec-fetch-mode"] === "navigate" &&
        req.headers["sec-fetch-dest"] === "document" &&
        !isApiPath;
      // Opening the local setup link from another app is a document navigation.
      // API calls and cross-site subresource requests keep the stricter boundary.
      if (req.headers["sec-fetch-site"] === "cross-site" && !safeDocumentNavigation)
        throw new HttpError(403, "Cross-site studio requests are not allowed.");
      if (url.pathname.startsWith("/api/studio/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes))
          throw new HttpError(401, "Open this studio's setup link to connect.");
        if (url.search) throw new HttpError(400, "Studio API queries are not supported.");
        const route = url.pathname.slice("/api/studio/".length);
        if (req.method === "GET" && route === "status")
          return json(res, 200, await service.status());
        if (req.method === "POST" && route === "unlock") {
          const value = parse(
            z.object({ passphrase: z.string().min(12).max(1024) }).strict(),
            await body(req),
          );
          await service.unlock(value.passphrase);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && route === "lock") {
          parse(z.object({}).strict(), await body(req));
          await service.lock();
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && route === "credentials") {
          const value = parse(
            z
              .object({ provider: z.enum(["google", "xai"]), apiKey: z.string().min(8).max(4096) })
              .strict(),
            await body(req),
          );
          await service.setCredential(value.provider, value.apiKey);
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && route === "credentials") {
          const value = parse(
            z.object({ provider: z.enum(["google", "xai"]) }).strict(),
            await body(req),
          );
          await service.removeCredential(value.provider);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && route === "budget") {
          const value = parse(
            z.object({ limitUsd: z.number(), perJobUsd: z.number() }).strict(),
            await body(req),
          );
          await service.setBudget(value);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && route === "jobs") {
          const value = parse(
            z
              .object({
                requestId: z.string(),
                generation: z.unknown(),
                processing: z.unknown().optional(),
              })
              .strict(),
            await body(req, 36 * 1024 * 1024),
          );
          return json(
            res,
            202,
            await service.createJob({
              requestId: value.requestId,
              generation: value.generation as GenerationInput,
              processing: value.processing as ProcessingInput,
            }),
          );
        }
        if (req.method === "POST" && route === "import") {
          const value = parse(
            z
              .object({
                requestId: z.string(),
                fileName: z.string(),
                videoBase64: z.string(),
                processing: z.unknown().optional(),
              })
              .strict(),
            await body(req, Math.ceil(MAX_VIDEO_BYTES / 3) * 4 + jsonLimit),
          );
          return json(
            res,
            202,
            await service.importVideo({
              ...value,
              processing: value.processing as ProcessingInput,
            }),
          );
        }
        const match =
          /^jobs\/([0-9a-f-]+)(?:\/(files\/([^/]+)|retry-processing|resolve-uncertain))?$/i.exec(
            route,
          );
        if (match) {
          if (req.method === "GET" && !match[2]) return json(res, 200, await service.job(match[1]));
          if (req.method === "POST" && match[2] === "retry-processing") {
            const value = parse(
              z.object({ processing: z.unknown().optional() }).strict(),
              await body(req),
            );
            return json(
              res,
              202,
              await service.retryProcessing(match[1], value.processing as ProcessingInput),
            );
          }
          if (req.method === "POST" && match[2] === "resolve-uncertain") {
            const value = parse(
              z.object({ acknowledge: z.literal(true) }).strict(),
              await body(req),
            );
            void value;
            // This action is deliberately absent from the MCP tool surface.
            return json(res, 200, await service.resolveUncertain(match[1]));
          }
          if (req.method === "GET" && match[3]) {
            const path = await service.artifactPath(match[1], match[3]);
            res.writeHead(200, {
              ...secureHeaders,
              "Content-Type":
                match[3] === "video.mp4"
                  ? "video/mp4"
                  : match[3] === "sheet.png"
                    ? "image/png"
                    : "application/json",
              "Content-Length": (await stat(path)).size,
            });
            await pipeline(createReadStream(path), res);
            return;
          }
        }
        throw new HttpError(404, "Studio endpoint not found.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new HttpError(405, "Method not allowed.");
      if (url.pathname === "/setup" || url.pathname === "/setup/") {
        const nonce = randomBytes(18).toString("base64");
        res.writeHead(200, {
          ...secureHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        });
        return res.end(req.method === "HEAD" ? undefined : setupHtml(nonce));
      }
      if (url.pathname === "/") {
        res.writeHead(302, { ...secureHeaders, Location: webRoot ? "/animate" : "/setup" });
        return res.end();
      }
      if (webRoot) {
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          throw new HttpError(400, "Invalid local request path.");
        }
        if (
          pathname.includes("\0") ||
          pathname.includes("\\") ||
          pathname.split("/").some((part) => part === ".." || part.startsWith("."))
        )
          throw new HttpError(404, "File not found.");
        let candidate = resolve(webRoot, `.${pathname}`);
        if (pathname.endsWith("/")) candidate = join(candidate, "index.html");
        else if (!extname(candidate)) candidate += ".html";
        if (!nested(webRoot, candidate) || !contentTypes[extname(candidate)])
          throw new HttpError(404, "File not found.");
        let path: string;
        try {
          path = await realpath(candidate);
        } catch {
          throw new HttpError(404, "File not found.");
        }
        if (!nested(webRoot, path) || !(await stat(path)).isFile())
          throw new HttpError(404, "File not found.");
        res.writeHead(200, {
          ...secureHeaders,
          "Content-Type": contentTypes[extname(candidate)],
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        });
        if (req.method === "HEAD") return res.end();
        await pipeline(createReadStream(path), res);
        return;
      }
      throw new HttpError(
        404,
        "Build the web workspace and start with --web-root, or open /setup.",
      );
    })().catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.setHeader("Connection", "close");
      json(res, error instanceof HttpError ? error.status : 400, { error: safeError(error) });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 40;
  try {
    if (
      options.port !== undefined &&
      (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    )
      throw new Error("Choose a valid local port.");
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((accept, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onReady);
            reject(error);
          };
          const onReady = () => {
            server.off("error", onError);
            accept();
          };
          server.once("error", onError);
          server.once("listening", onReady);
          server.listen(options.port ?? randomInt(49152, 65536), "127.0.0.1");
        });
        break;
      } catch (error) {
        if (
          options.port !== undefined ||
          (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
          attempt >= 2
        )
          throw error;
      }
    }
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writePrivateJson(join(service.stateDir, "connection.json"), {
      origin,
      token,
      pid: process.pid,
    });
  } catch (error) {
    server.close();
    await service.close();
    throw error;
  }
  return {
    server,
    origin,
    token,
    async close() {
      if (stopping) return;
      stopping = true;
      const stopped = new Promise<void>((accept) => server.close(() => accept()));
      server.closeAllConnections();
      await service.close();
      await stopped;
      try {
        const connection = JSON.parse(
          await readFile(join(service.stateDir, "connection.json"), "utf8"),
        );
        if (connection.token === token) await unlink(join(service.stateDir, "connection.json"));
      } catch {
        /* Preserve unrelated replacement connection metadata. */
      }
    },
  };
}
