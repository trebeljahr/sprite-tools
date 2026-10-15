import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

it("drains on SIGTERM: keeps serving through the drain, then exits cleanly", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { PATH: process.env.PATH, PORT: "0", SHUTDOWN_DRAIN_SECONDS: "0.6" } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  try {
    for (let i = 0; !/Listening on \S+:\d+/.test(output) && i < 200; i++) await sleep(25);
    const port = output.match(/Listening on \S+:(\d+)/)?.[1];
    expect(port, output).toBeTruthy();
    const base = `http://127.0.0.1:${port}`;
    // Unconfigured accounts: not ready, but answering.
    expect((await fetch(`${base}/api/account`)).status).toBe(401);
    const started = Date.now();
    child.kill("SIGTERM");
    await sleep(150);
    const probe = await fetch(`${base}/api/health/accounts`);
    expect(probe.status).toBe(503);
    expect((await fetch(`${base}/api/account`)).status).toBe(401);
    expect(await exited).toEqual([0, null]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  } finally {
    child.kill("SIGKILL");
  }
}, 15000);
