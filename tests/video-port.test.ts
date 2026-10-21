import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startStudio } from "../src/lib/video/http";

const dirs: string[] = [];
const studios: Awaited<ReturnType<typeof startStudio>>[] = [];
afterEach(async () => {
  for (const studio of studios.splice(0)) await studio.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "sprite-studio-port-"));
  dirs.push(dir);
  return dir;
}

it("reuses the same studio address after restart while rotating its session capability", async () => {
  const stateDir = await directory();
  const first = await startStudio({ stateDir, simulation: true });
  const origin = first.origin,
    token = first.token;
  const settingsPath = join(stateDir, "studio-settings.json");
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    version: 1,
    port: Number(new URL(origin).port),
  });
  expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  await first.close();
  const second = await startStudio({ stateDir, simulation: true });
  studios.push(second);
  expect(second.origin).toBe(origin);
  expect(second.token).not.toBe(token);
});

it("does not silently change a saved address when that port is occupied", async () => {
  const stateDir = await directory();
  const first = await startStudio({ stateDir, simulation: true });
  const port = Number(new URL(first.origin).port);
  await first.close();
  const other = createServer();
  await new Promise<void>((resolve, reject) => {
    other.once("error", reject);
    other.listen(port, "127.0.0.1", resolve);
  });
  try {
    await expect(startStudio({ stateDir, simulation: true })).rejects.toThrow(
      `Studio port ${port} is already in use`,
    );
    expect(JSON.parse(await readFile(join(stateDir, "studio-settings.json"), "utf8"))).toEqual({
      version: 1,
      port,
    });
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
  // A failed bind must release the studio storage lock too.
  const recovered = await startStudio({ stateDir, simulation: true });
  studios.push(recovered);
  expect(Number(new URL(recovered.origin).port)).toBe(port);
});

it("lets a temporary listener opt out without overwriting the saved address", async () => {
  const stateDir = await directory();
  const first = await startStudio({ stateDir, simulation: true });
  const saved = await readFile(join(stateDir, "studio-settings.json"), "utf8");
  await first.close();
  const temporary = await startStudio({ stateDir, simulation: true, port: 0 });
  studios.push(temporary);
  expect(await readFile(join(stateDir, "studio-settings.json"), "utf8")).toBe(saved);
});

it("fails clearly on malformed saved settings and allows an explicit port to recover", async () => {
  const stateDir = await directory();
  const first = await startStudio({ stateDir, simulation: true });
  const port = Number(new URL(first.origin).port);
  await first.close();
  await writeFile(join(stateDir, "studio-settings.json"), "not json");
  await expect(startStudio({ stateDir, simulation: true })).rejects.toThrow(
    "Invalid saved studio port",
  );
  const recovered = await startStudio({ stateDir, simulation: true, port });
  studios.push(recovered);
  expect(JSON.parse(await readFile(join(stateDir, "studio-settings.json"), "utf8"))).toEqual({
    version: 1,
    port,
  });
});
