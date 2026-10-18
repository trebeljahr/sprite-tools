import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "./schema.js";

export function defaultStateDir(): string {
  return resolve(
    process.env.SPRITE_TOOLS_VIDEO_HOME || join(homedir(), ".config", "sprite-tools", "video"),
  );
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Studio storage must be a private directory.");
  await chmod(path, 0o700);
}
export async function writePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  let file: FileHandle | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(value);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => undefined);
  }
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, JSON.stringify(value));
}
type Keys = Partial<Record<ProviderId, string>>;
interface VaultFile {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  providers: ProviderId[];
}
const AAD = Buffer.from("sprite-tools/provider-vault/v1");
function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(
      passphrase,
      salt,
      32,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(new Error("The credential vault could not be unlocked."));
        else resolveKey(key);
      },
    );
  });
}
export class CredentialVault {
  private key?: Buffer;
  private salt?: Buffer;
  private keys: Keys = {};
  private configured = new Set<ProviderId>();
  constructor(private readonly file: string) {}
  get locked(): boolean {
    return !this.key;
  }
  has(provider: ProviderId): boolean {
    return this.configured.has(provider);
  }
  async inspect(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as VaultFile;
      if (stored.version !== 1 || !Array.isArray(stored.providers)) throw new Error();
      this.configured = new Set(stored.providers.filter((p) => p === "google" || p === "xai"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("The credential vault could not be read.");
    }
  }
  async unlock(passphrase: string): Promise<void> {
    if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024)
      throw new Error("Use a vault passphrase of 12 to 1024 characters.");
    let stored: VaultFile | undefined;
    try {
      stored = JSON.parse(await readFile(this.file, "utf8")) as VaultFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("The credential vault could not be read.");
    }
    const salt = stored ? Buffer.from(stored.salt, "base64") : randomBytes(32);
    if (salt.length !== 32) throw new Error("The credential vault could not be unlocked.");
    const key = await derive(passphrase, salt);
    let keys: Keys = {};
    if (stored) {
      try {
        if (stored.version !== 1) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
        decipher.setAAD(AAD);
        decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(stored.ciphertext, "base64")),
          decipher.final(),
        ]);
        try {
          const parsed = JSON.parse(plaintext.toString("utf8")) as Keys;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Object.entries(parsed).some(
              ([p, value]) => !["google", "xai"].includes(p) || typeof value !== "string",
            )
          )
            throw new Error();
          keys = parsed;
        } finally {
          plaintext.fill(0);
        }
      } catch {
        key.fill(0);
        throw new Error("The passphrase is incorrect or the vault is damaged.");
      }
    }
    this.lock();
    this.key = key;
    this.salt = salt;
    this.keys = keys;
    this.configured = new Set(Object.keys(keys) as ProviderId[]);
    if (!stored) await this.save();
  }
  lock(): void {
    this.key?.fill(0);
    this.key = undefined;
    this.salt = undefined;
    this.keys = {};
  }
  get(provider: ProviderId): string {
    if (this.locked) throw new Error("Unlock the local credential vault first.");
    const key = this.keys[provider];
    if (!key) throw new Error("Save an API key for this provider in local setup first.");
    return key;
  }
  async set(provider: ProviderId, apiKey: string): Promise<void> {
    if (this.locked) throw new Error("Unlock the local credential vault first.");
    if (
      !["google", "xai"].includes(provider) ||
      typeof apiKey !== "string" ||
      apiKey.length < 8 ||
      apiKey.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(apiKey)
    )
      throw new Error("Enter a valid provider API key.");
    this.keys[provider] = apiKey;
    this.configured.add(provider);
    await this.save();
  }
  async remove(provider: ProviderId): Promise<void> {
    if (this.locked) throw new Error("Unlock the local credential vault first.");
    delete this.keys[provider];
    this.configured.delete(provider);
    await this.save();
  }
  private async save(): Promise<void> {
    if (!this.key || !this.salt) throw new Error("Unlock the local credential vault first.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(this.keys));
    let ciphertext: Buffer;
    try {
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } finally {
      plaintext.fill(0);
    }
    await writePrivateJson(this.file, {
      version: 1,
      salt: this.salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      providers: [...this.configured],
    } satisfies VaultFile);
  }
}
