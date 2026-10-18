import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startStudio } from "../src/lib/video/http";
const directories: string[] = [];
const studios: Awaited<ReturnType<typeof startStudio>>[] = [];
afterEach(async () => {
  await Promise.all(studios.splice(0).map((studio) => studio.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(withWeb = false) {
  const dir = await mkdtemp(join(tmpdir(), "sprite-video-http-"));
  directories.push(dir);
  const stateDir = join(dir, "state");
  const webRoot = join(dir, "web");
  if (withWeb) {
    await mkdir(webRoot);
    await writeFile(join(webRoot, "animate.html"), "<!doctype html><h1>Local workspace</h1>");
  }
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("No live provider request allowed"));
  const studio = await startStudio({
    stateDir,
    port: 0,
    ...(withWeb ? { webRoot } : {}),
    transport,
  });
  studios.push(studio);
  const headers = {
    Authorization: `Bearer ${studio.token}`,
    "Content-Type": "application/json",
    Origin: studio.origin,
  };
  const post = (route: string, data: unknown) =>
    fetch(`${studio.origin}/api/studio/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
  return { dir, stateDir, webRoot, studio, headers, post, transport };
}
function requestHost(origin: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${origin}/setup`, { headers: { Host: host } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("local studio HTTP boundary", () => {
  it("requires an exact host, same origin when supplied, and bearer authentication", async () => {
    const { studio, headers } = await fixture();
    expect((await fetch(`${studio.origin}/api/studio/status`)).status).toBe(401);
    expect((await fetch(`${studio.origin}/api/studio/status?token=${studio.token}`)).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${studio.origin}/api/studio/status`, {
          headers: { ...headers, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${studio.origin}/api/studio/status`, {
          headers: { ...headers, Origin: "null" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${studio.origin}/api/studio/status`, {
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(await requestHost(studio.origin, "attacker.example")).toBe(403);
    expect(await requestHost(studio.origin, `localhost:${new URL(studio.origin).port}`)).toBe(403);
    const valid = await fetch(`${studio.origin}/api/studio/status`, {
      headers: { Authorization: headers.Authorization },
    });
    expect(valid.status).toBe(200);
    expect(valid.headers.get("access-control-allow-origin")).toBeNull();
    expect(await valid.json()).toMatchObject({ locked: true, budget: { limitUsd: 0 } });
  });
  it("allows cross-site document navigation only for setup and static pages", async () => {
    const { studio, headers } = await fixture(true);
    const navigation = {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    };
    const get = (path: string, requestHeaders: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${studio.origin}${path}`,
          { headers: requestHeaders },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end();
      });
    expect(await get("/setup", navigation)).toBe(200);
    expect(await get("/animate", navigation)).toBe(200);
    expect(
      await get("/api/studio/status", { ...navigation, Authorization: headers.Authorization }),
    ).toBe(403);
    expect(
      await get("/setup", {
        ...navigation,
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Dest": "image",
      }),
    ).toBe(403);
    expect(await get("/setup", { ...navigation, Origin: "https://attacker.example" })).toBe(403);
  });
  it("keeps credentials out of status, errors, setup HTML and unencrypted files", async () => {
    const { studio, post, headers, stateDir, transport } = await fixture();
    expect((await post("unlock", { passphrase: "test-only-http-passphrase" })).status).toBe(200);
    expect(
      (await post("credentials", { provider: "xai", apiKey: "fake-http-secret-provider-key" }))
        .status,
    ).toBe(200);
    expect((await post("budget", { limitUsd: 10, perJobUsd: 1 })).status).toBe(200);
    const status = await fetch(`${studio.origin}/api/studio/status`, { headers });
    expect(await status.text()).not.toContain("fake-http-secret");
    const invalid = await fetch(`${studio.origin}/api/studio/credentials`, {
      method: "POST",
      headers,
      body: '{"apiKey":"fake-http-secret-provider-key"',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe('{"error":"Invalid JSON request body."}');
    const vault = await readFile(join(stateDir, "vault.json"), "utf8");
    expect(vault).not.toContain("fake-http-secret");
    expect(vault).not.toContain("test-only-http-passphrase");
    expect((await stat(join(stateDir, "connection.json"))).mode & 0o777).toBe(0o600);
    expect(transport).not.toHaveBeenCalled();
  });
  it("serves a nonce-protected setup without embedding the capability token", async () => {
    const { studio } = await fixture();
    const response = await fetch(`${studio.origin}/setup`);
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(response.status).toBe(200);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+'/);
    expect(html).toContain('type="password"');
    expect(html).toContain('form method="post"');
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain(studio.token);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("checks Google model access without a generation request or budget reservation", async () => {
    const { studio, headers, post, transport } = await fixture();
    const model = "veo-3.1-lite-generate-preview";
    expect(
      (
        await fetch(`${studio.origin}/api/studio/verify-google-model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        })
      ).status,
    ).toBe(401);
    expect((await post("verify-google-model", { model })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    await post("unlock", { passphrase: "test-only-http-passphrase" });
    await post("credentials", { provider: "google", apiKey: "fake-check-only-google-key" });
    expect((await post("verify-google-model", { model: "../../private" })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(
      Response.json({
        name: `models/${model}`,
        supportedGenerationMethods: ["predictLongRunning"],
        description: "fake-sensitive-provider-data",
      }),
    );
    const check = await post("verify-google-model", { model });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ available: true, supportsGeneration: true });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.method).toBe("GET");
    const status = await (await fetch(`${studio.origin}/api/studio/status`, { headers })).json();
    expect(status.jobs).toEqual([]);
    expect(status.budget.committedUsd).toBe(0);
    transport.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            message: "fake-check-only-google-key fake-sensitive-provider-data",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
            ],
          },
        },
        { status: 400 },
      ),
    );
    const failure = await post("verify-google-model", { model });
    expect(failure.status).toBe(400);
    expect(await failure.text()).not.toContain("fake-");
  });
  it("serves the local web export but prevents symlink escapes and private storage exposure", async () => {
    const { studio, webRoot, stateDir } = await fixture(true);
    expect((await fetch(`${studio.origin}/animate`)).status).toBe(200);
    const root = await fetch(studio.origin, { redirect: "manual" });
    expect(root.headers.get("location")).toBe("/animate");
    await symlink(join(stateDir, "connection.json"), join(webRoot, "leak.json"));
    expect((await fetch(`${studio.origin}/leak.json`)).status).toBe(404);
    expect((await fetch(`${studio.origin}/%2e%2e/state/connection.json`)).status).toBe(404);
    expect((await fetch(`${studio.origin}/.env`)).status).toBe(404);
    const other = await mkdtemp(join(tmpdir(), "sprite-video-overlap-"));
    directories.push(other);
    await expect(
      startStudio({ stateDir: join(other, "state"), webRoot: other, port: 0 }),
    ).rejects.toThrow("outside the served web");
  });
  it("rejects unauthenticated uploads before waiting for their bodies", async () => {
    const { studio } = await fixture();
    const code = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${studio.origin}/api/studio/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": "1000000" },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            req.destroy();
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on("error", reject);
      req.write('{"videoBase64":"');
    });
    expect(code).toBe(401);
  });
});
