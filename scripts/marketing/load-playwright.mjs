// Playwright is not a project dependency. Use the copy the machine already
// has: a local install, `npm root -g`, or any nvm-installed global, and the
// newest headless Chromium shell in the Playwright browser cache. Override
// with PLAYWRIGHT_MODULE (path to the playwright package directory) and
// CHROMIUM_PATH (path to a Chromium or headless-shell binary).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function candidateModuleDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_MODULE) dirs.push(process.env.PLAYWRIGHT_MODULE);
  try {
    dirs.push(join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright"));
  } catch {}
  const nvm = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    for (const v of readdirSync(nvm).sort().reverse()) {
      dirs.push(join(nvm, v, "lib", "node_modules", "playwright"));
    }
  }
  return dirs;
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const shell of shells) {
    for (const arch of [
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell-mac-x64",
      "chrome-headless-shell-linux64",
    ]) {
      const bin = join(cache, shell, arch, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

export async function launchChromium() {
  let mod;
  try {
    mod = await import("playwright");
  } catch {
    for (const dir of candidateModuleDirs()) {
      const entry = join(dir, "index.mjs");
      if (existsSync(entry)) {
        mod = await import(pathToFileURL(entry).href);
        break;
      }
    }
  }
  if (!mod) throw new Error("Playwright not found. Install it globally or set PLAYWRIGHT_MODULE.");
  const executablePath = findChromium();
  return mod.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
