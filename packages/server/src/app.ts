import { toNodeHandler } from "better-auth/node";
import express from "express";
import helmet from "helmet";
import { getAuth } from "./auth.js";
import { account } from "./routes/account.js";
import { envelope } from "./routes/envelope.js";
import { isProxyDraining, isTraefikProbe } from "./drain.js";
import { accountsHealth, health } from "./routes/health.js";
import { videoUnavailable } from "./routes/video.js";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Every route lives under /api: the static client is served by a Cloudflare
 * Worker on the same hostname, and only `/api/*` reaches this server (a
 * Workers route with no Worker). Same origin, so no CORS; Better Auth checks
 * the Origin header against BETTER_AUTH_URL itself.
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Traefik's drain probe — ahead of everything, so a request that arrives
  // every few seconds skips CORS, logging and the database. It reports only
  // whether this container is draining; readiness is the health check Docker
  // runs. Traefik sends it straight to this container with an
  // X-Hatchkit-Drain header; a visitor's request is forwarded by Traefik,
  // which always adds X-Forwarded-For, so a visitor can't pose as it.
  app.use((req, res, next) => {
    if (!isTraefikProbe(req.headers)) return next();
    const draining = isProxyDraining();
    res
      .status(draining ? 503 : 200)
      .set("cache-control", "no-store")
      .type("text/plain")
      .send(draining ? "draining\n" : "serving\n");
  });
  app.use(helmet());

  // Better Auth parses its own bodies, so no body parser runs ahead of it.
  let auth: ReturnType<typeof toNodeHandler> | undefined;
  app.all("/api/auth/{*path}", async (req, res) => {
    try {
      auth ??= toNodeHandler(getAuth());
      await auth(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.status(503).set(NO_STORE).json({ message: "Accounts are temporarily unavailable" });
    }
  });

  app.get("/api/account", account);
  app.get("/api/health", health);
  app.get("/api/health/accounts", accountsHealth);
  app.post("/api/_e", envelope);
  app.post("/api/video/generations", videoUnavailable);
  app.get("/api/video/generations/{*id}", videoUnavailable);

  app.use((_req, res) => {
    res.status(404).set(NO_STORE).json({ error: "Not found" });
  });
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) res.destroy();
      else res.status(500).set(NO_STORE).json({ error: "Internal error" });
    },
  );
  return app;
}
