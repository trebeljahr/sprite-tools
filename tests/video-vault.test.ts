import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialVault } from "../src/lib/video/vault";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sprite-video-vault-"));
  directories.push(dir);
  return { dir, path: join(dir, "vault.json") };
}

describe("local video credential vault", () => {
  it("encrypts keys, uses private permissions, and restarts locked", async () => {
    const { dir, path } = await fixture();
    const vault = new CredentialVault(path);
    await vault.inspect();
    expect(vault.locked).toBe(true);
    await vault.unlock("test-only-passphrase-123");
    await vault.set("google", "fake-google-key-never-persist-plaintext");
    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain("fake-google-key");
    expect(stored).not.toContain("test-only-passphrase");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    vault.lock();
    expect(() => vault.get("google")).toThrow("Unlock");
    const restarted = new CredentialVault(path);
    await restarted.inspect();
    expect(restarted.locked).toBe(true);
    expect(restarted.has("google")).toBe(true);
    await expect(restarted.unlock("incorrect-test-passphrase")).rejects.toThrow("incorrect");
    expect(restarted.locked).toBe(true);
    await restarted.unlock("test-only-passphrase-123");
    expect(restarted.get("google")).toBe("fake-google-key-never-persist-plaintext");
    await restarted.remove("google");
    expect(restarted.has("google")).toBe(false);
    restarted.lock();
  });
  it("detects ciphertext tampering without returning credentials", async () => {
    const { path } = await fixture();
    const vault = new CredentialVault(path);
    await vault.unlock("test-only-passphrase-123");
    await vault.set("xai", "fake-xai-secret-key");
    vault.lock();
    const data = JSON.parse(await readFile(path, "utf8"));
    data.tag = Buffer.alloc(16).toString("base64");
    await writeFile(path, JSON.stringify(data));
    await expect(vault.unlock("test-only-passphrase-123")).rejects.toThrow("vault is damaged");
    expect(vault.locked).toBe(true);
  });
});
