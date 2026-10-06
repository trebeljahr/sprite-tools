"use strict";
// Intercept assets before Next's startup-time file inventory. An older server
// must see files published by a newer peer after that older server started.
const { open, readFile } = require("node:fs/promises");
const { readFileSync, constants } = require("node:fs");
const { join, extname } = require("node:path");
const http = require("node:http");
const { createGzip } = require("node:zlib");
const { pipeline } = require("node:stream");
const STORE = "/var/lib/sprite-tools-releases";
const TYPES = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".wasm": "application/wasm",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".glb": "model/gltf-binary",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function reply(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`${message}\n`);
}
function handler(store, revision) {
  if (!isSha(revision)) throw Error("Invalid local asset revision.");
  return function shared(req, res) {
    const pathname = (req.url || "").split("?")[0];
    const client = req.headers["x-deployment-id"];
    // Refuse mixed RSC before React decodes references from a different build.
    // Next treats a non-flight response as one full navigation to the same URL.
    if (req.headers.rsc === "1" && client !== undefined && client !== revision) {
      reply(res, isSha(client) ? 409 : 400, "Release changed; navigate with the current document.");
      return true;
    }
    if (pathname !== "/releases.json" && !pathname.startsWith("/_next/static/")) return false;
    if (!["GET", "HEAD"].includes(req.method)) {
      reply(res, 405, "Method not allowed.");
      return true;
    }
    void serve(req, res, pathname, store).catch(() => {
      if (res.headersSent) res.destroy();
      else reply(res, 503, "Browser asset unavailable.");
    });
    return true;
  };
}
async function serve(req, res, pathname, store) {
  if (pathname === "/releases.json") {
    const bytes = await readFile(join(store, "releases.json"));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return;
  }
  const relative = pathname.slice("/_next/static/".length);
  if (
    relative.length > 1024 ||
    !relative
      .split("/")
      .every((segment) => /^[a-zA-Z0-9_.~-]+$/.test(segment) && segment !== "." && segment !== "..")
  ) {
    reply(res, 400, "Invalid asset path.");
    return;
  }
  let file;
  try {
    file = await open(
      join(store, "_next/static", relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) {
      reply(res, 404, "Asset not retained.");
      return;
    }
    throw error;
  }
  try {
    const stat = await file.stat();
    if (res.destroyed) return;
    if (!stat.isFile()) {
      reply(res, 404, "Asset not retained.");
      return;
    }
    let start = 0,
      end = stat.size - 1,
      status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) {
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        reply(res, 416, "Invalid range.");
        return;
      }
      if (!range[1]) start = Math.max(0, stat.size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= stat.size
      ) {
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        reply(res, 416, "Invalid range.");
        return;
      }
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    const acceptsGzip = String(req.headers["accept-encoding"] || "")
      .split(",")
      .some((value) => {
        const [name, quality] = value.trim().split(";");
        return (
          name.toLowerCase() === "gzip" &&
          (!quality || /^q=(?:1(?:\.0*)?|0\.\d*[1-9]\d*)$/.test(quality.trim()))
        );
      });
    const compress =
      status === 200 &&
      stat.size >= 1024 &&
      /\.(?:m?js|css|json|map|svg)$/i.test(relative) &&
      acceptsGzip;
    res.writeHead(status, {
      "Content-Type": TYPES[extname(relative).toLowerCase()] || "application/octet-stream",
      ...(compress
        ? { "Content-Encoding": "gzip" }
        : { "Content-Length": Math.max(0, end - start + 1) }),
      Vary: "Accept-Encoding",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD" || stat.size === 0) {
      res.end();
      return;
    }
    const stream = file.createReadStream({ start, end, autoClose: true });
    file = null;
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    if (compress) pipeline(stream, createGzip({ level: 6 }), res, () => {});
    else stream.pipe(res);
  } finally {
    await file?.close();
  }
}
// Every http.Server answers the shared namespace before Next sees the request.
function install(store, revision) {
  const shared = handler(store, revision);
  const original = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === "request" && shared(args[0], args[1])) return true;
    return original.call(this, event, ...args);
  };
}
module.exports = { handler, install };
if (process.env.SPRITE_SHARED_ASSETS === "1") {
  install(STORE, JSON.parse(readFileSync("/app/release-assets/version.json", "utf8")).commit);
}
