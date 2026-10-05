import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Browser assets shared by every container that overlaps during a rolling
// release. See scripts/RETAINED-ASSETS.md for the volume contract.
export const STORE = "/var/lib/sprite-tools-releases";
export const SOURCE = "/app/release-assets";
export const STORE_ID = Object.freeze({
  schema: 1,
  app: "trebeljahr/sprite-tools",
  volume: "sprite-tools-releases",
  purpose: "immutable-next-assets",
});
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_STORE_FILES = 20000;
const WINDOW = 3;
const isSha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function files(root, prefix = "") {
  if (!(await lstat(root)).isDirectory()) throw new Error("Expected a real directory.");
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...(await files(join(root, entry.name), `${relative}/`)));
    else if (entry.isFile()) result.push(relative);
    else throw new Error("Unsupported release file.");
  }
  return result;
}
async function safeDirectory(path) {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory()) throw new Error("Expected a real directory.");
}
export async function inventoryHash(root) {
  const entries = [];
  for (const path of (await files(root)).sort()) {
    const bytes = await readFile(join(root, path));
    entries.push({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
async function copyTree(from, to) {
  await safeDirectory(to);
  for (const relative of await files(from)) {
    const target = join(to, relative);
    await safeDirectory(resolve(target, ".."));
    await copyFile(join(from, relative), target);
  }
}
async function atomicJson(path, data) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: "wx" });
  await rename(temporary, path);
}
export async function validateMount(store = STORE, mountInfo) {
  if (store !== STORE) throw new Error("Unexpected release store path.");
  if (!(await lstat(store)).isDirectory()) throw new Error("Release store is not a directory.");
  const info = mountInfo ?? (await readFile("/proc/self/mountinfo", "utf8"));
  const mounts = info
    .trim()
    .split("\n")
    .filter((line) => line.split(" ")[4] === STORE);
  if (mounts.length !== 1 || !mounts[0].split(" ")[5].split(",").includes("rw"))
    throw new Error("Required writable release-store mount is absent.");
  // Before locking, inspect only stable names. Another publisher can be
  // atomically replacing trees; the full recursive check runs under the lock.
  for (const entry of await readdir(store, { withFileTypes: true }))
    if (entry.isSymbolicLink()) throw new Error("Unexpected store symlink.");
  const leases = join(store, "leases");
  if (await present(leases)) await files(leases);
  const publishLock = join(store, ".publish.lock");
  if ((await present(publishLock)) && !(await lstat(publishLock)).isFile())
    throw new Error("Invalid publication lock.");
  const marker = await json(join(store, ".store-identity.json"));
  if (JSON.stringify(marker) !== JSON.stringify(STORE_ID))
    throw new Error("Release store identity differs.");
}
export async function releaseSha(source) {
  const sha = (await json(join(source, "version.json"))).commit;
  if (!isSha(sha)) throw new Error("Invalid local release.");
  return sha;
}
function heldLease(path) {
  const result = spawnSync("flock", ["-n", "-x", path, "true"], { stdio: "ignore" });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error("Could not inspect a release lease.");
}

// Call with the global publish lock held and a shared lease on this image's SHA.
// `source` holds `version.json` and this image's `_next/static`. Every image
// publishes itself, so the store needs no image ancestry: the newest start
// becomes the head and the three latest releases plus every leased (still
// running) image stay available. Tests inject the lease observer.
export async function publishRelease(source, store, { isHeld = heldLease } = {}) {
  await files(store);
  // Bound crash leftovers and repeated candidates. Reproducible browser
  // assets must never turn this volume into an unbounded archive.
  let bytes = 0;
  let count = 0;
  for (const root of [store, source])
    for (const name of await files(root)) {
      bytes += (await lstat(join(root, name))).size;
      count++;
      if (bytes > MAX_STORE_BYTES || count > MAX_STORE_FILES)
        throw new Error("Release store capacity requires reconciliation.");
    }
  const sha = await releaseSha(source);
  if (
    (await files(source)).some(
      (name) => name !== "version.json" && !name.startsWith("_next/static/"),
    )
  )
    throw new Error("Unexpected file in the image release bundle.");
  for (const directory of ["releases", "leases", "_next/static"])
    await safeDirectory(join(store, directory));
  let old = null;
  if (await present(join(store, "releases.json"))) old = await json(join(store, "releases.json"));
  if (
    old &&
    (old.schema !== 2 ||
      !isSha(old.head) ||
      !Array.isArray(old.window) ||
      old.window.length > WINDOW ||
      old.window[0] !== old.head ||
      old.window.some((id) => !isSha(id)) ||
      !Array.isArray(old.releases) ||
      old.releases.length > WINDOW * 2 ||
      old.releases.some((id) => !isSha(id)))
  )
    throw new Error("Invalid shared retention metadata.");
  // Restarting within the window never rewinds the head another image set.
  const restarting = old?.window.includes(sha) ?? false;
  const held = [];
  for (const name of await readdir(join(store, "leases"))) {
    if (!/^[a-f0-9]{40}\.lock$/.test(name) || !(await lstat(join(store, "leases", name))).isFile())
      throw new Error("Invalid lease file.");
    if (isHeld(join(store, "leases", name))) held.push(name.slice(0, 40));
  }
  if (held.length > WINDOW || !held.includes(sha))
    throw new Error("Missing image lease or too many live releases.");
  // Publish this image's snapshot before exposing metadata or starting Next.
  const own = join(store, "releases", sha);
  const expected = await inventoryHash(source);
  if (await present(own)) {
    if ((await inventoryHash(own)) !== expected) throw new Error("Immutable release collision.");
  } else {
    const staging = join(store, `.stage-${randomUUID()}`);
    try {
      await copyTree(source, staging);
      await rename(staging, own);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const candidates = restarting
    ? old.window
    : [sha, ...(old?.window ?? []).filter((id) => id !== sha)];
  const keep = [];
  for (const id of [...new Set([...candidates.slice(0, WINDOW), ...held])]) {
    const tree = join(store, "releases", id);
    if ((await present(tree)) && (await releaseSha(tree)) === id) keep.push(id);
    else if (held.includes(id)) throw new Error("A serving image has lost its published assets.");
    // A window entry whose files are gone (a recreated volume) is dropped, so
    // its tabs see expiry rather than missing chunks.
  }
  const window = candidates.slice(0, WINDOW).filter((id) => keep.includes(id));
  const required = new Set();
  for (const id of keep) {
    const input = join(store, "releases", id, "_next/static");
    if (!(await present(input))) continue;
    for (const relative of await files(input)) {
      required.add(relative);
      const destination = join(store, "_next/static", relative);
      await safeDirectory(resolve(destination, ".."));
      if (await present(destination)) {
        if (
          !(await lstat(destination)).isFile() ||
          !(await readFile(destination)).equals(await readFile(join(input, relative)))
        )
          throw new Error("Immutable asset collision.");
      } else {
        // Copy into the volume, then atomically link: readers never see a partial file.
        const staged = join(store, `.asset-${randomUUID()}`);
        try {
          await copyFile(join(input, relative), staged);
          await link(staged, destination);
        } finally {
          await rm(staged, { force: true });
        }
      }
    }
  }
  const metadata = { schema: 2, head: window[0], window, releases: keep };
  await atomicJson(join(store, "releases.json"), metadata);
  // Kernel leases protect every still-running image, including the retiring one.
  for (const id of await readdir(join(store, "releases"))) {
    if (!isSha(id) || !(await lstat(join(store, "releases", id))).isDirectory())
      throw new Error("Invalid shared release directory.");
    if (!keep.includes(id)) await rm(join(store, "releases", id), { recursive: true });
  }
  for (const relative of await files(join(store, "_next/static")))
    if (!required.has(relative)) await rm(join(store, "_next/static", relative));
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation] = process.argv.slice(2);
    await validateMount();
    if (operation === "check") console.log(await releaseSha(SOURCE));
    else if (operation === "publish") await publishRelease(SOURCE, STORE);
    else throw new Error("Unknown release-store operation.");
  } catch {
    console.error("Shared browser asset preparation failed.");
    process.exitCode = 1;
  }
}
