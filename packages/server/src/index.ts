import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadEnvironment } from "./config/env.js";
import { closeDatabase } from "./db.js";
import { isDraining, startDraining } from "./drain.js";
import { migrate } from "./migrate.js";
import { closeHttpServer } from "./shutdown.js";

loadEnvironment();

const port = process.env.PORT ? Number(process.env.PORT) : 3472;
const drainSeconds = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_SECONDS) || 0);
const server = createServer(createApp());

async function start() {
  try {
    // A failed migration must block the release: exit before turning healthy.
    if (process.env.ACCOUNTS_MIGRATE_ON_START === "true") await migrate();
    server.listen(port, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      console.log(`[server] Listening on http://127.0.0.1:${bound}`);
    });
  } catch (error) {
    console.error(`[server] ${error instanceof Error ? error.message : "Failed to start"}`);
    process.exit(1);
  }
}

// Counted from the start of shutdown, after the drain: 20 s of drain plus this
// stays under the 30 s stop timeout the release contract requires.
const FORCE_EXIT_MS = 8_000;
let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    console.error("[server] Forced exit after timeout");
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  console.log(`[server] ${signal}: closing`);
  await closeHttpServer(server).catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(0);
}

// SIGTERM is `docker stop`, usually a release replacing this container. Fail
// the health probe first so Traefik drops this container, keep serving for
// SHUTDOWN_DRAIN_SECONDS, then close. A second SIGTERM stops waiting.
process.on("SIGTERM", () => {
  if (drainSeconds > 0 && !isDraining()) {
    startDraining();
    console.log(`[server] SIGTERM: failing the health check for ${drainSeconds}s, then closing`);
    setTimeout(() => void shutdown("SIGTERM"), drainSeconds * 1000);
    return;
  }
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => void shutdown("SIGINT"));

void start();
