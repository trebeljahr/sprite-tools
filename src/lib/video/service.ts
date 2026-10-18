import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, lstat, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { processVideo, VideoProcessingError } from "./process.js";
import { resolveVideoTrim } from "./loop.js";
import {
  downloadVideo,
  pollGeneration,
  ProviderError,
  type ProviderOperation,
  type ProviderPoll,
  type ProviderTransport,
  submitGeneration,
  verifyGoogleModel,
} from "./providers.js";
import {
  artifactNames,
  estimateUsd,
  isBase64,
  MAX_VIDEO_BYTES,
  type ArtifactName,
  type GenerationInput,
  type ProcessingInput,
  type ProcessingOptions,
  type ProviderId,
  type PublicJob,
  type StudioStatus,
  validateGeneration,
  validateProcessing,
  VIDEO_PROVIDERS,
} from "./schema.js";
import {
  CredentialVault,
  defaultStateDir,
  ensurePrivateDirectory,
  writePrivateFile,
  writePrivateJson,
} from "./vault.js";

interface StoredJob extends PublicJob {
  requestId: string;
  digest: string;
  generation?: GenerationInput;
  processing: ProcessingOptions;
  operation?: ProviderOperation;
  hasVideo?: boolean;
}
interface State {
  version: 1;
  limitMicros: number;
  perJobMicros: number;
  jobs: StoredJob[];
}
export interface VideoServiceOptions {
  simulation?: boolean;
  stateDir?: string;
  transport?: ProviderTransport;
  processVideo?: typeof processVideo;
  pollIntervalMs?: number;
  maxPollMs?: number;
}
export interface CreateJobInput {
  requestId: string;
  generation: GenerationInput;
  processing?: ProcessingInput;
}
export interface ImportVideoInput {
  requestId: string;
  fileName: string;
  videoBase64: string;
  processing?: ProcessingInput;
}
const uuid = z.string().uuid();
const ACTIVE = new Set(["queued", "generating", "processing", "uncertain"]);
function dollars(micros: number): number {
  return micros / 1_000_000;
}
function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}
function requestId(raw: unknown): string {
  const result = uuid.safeParse(raw);
  if (!result.success) throw new Error("A unique UUID requestId is required.");
  return result.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const path = join(stateDir, "studio.lock");
  const nonce = randomBytes(16).toString("hex");
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Studio storage is locked. Stop the other studio first. After a crash, verify no studio is running before removing studio.lock; budgets and jobs must remain intact.",
      );
    throw new Error("Could not lock local studio storage.");
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return async () => {
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (saved.nonce === nonce) await unlink(path);
    } catch {
      /* A foreign or missing lock must never be removed. */
    }
  };
}
export class VideoService {
  readonly stateDir: string;
  private readonly vault: CredentialVault;
  private state: State = { version: 1, limitMicros: 0, perJobMicros: 0, jobs: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private task?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private stopping = false;
  private closeTask?: Promise<void>;
  private releaseLock?: () => Promise<void>;
  private constructor(private readonly options: VideoServiceOptions) {
    this.stateDir = resolve(options.stateDir ?? defaultStateDir());
    this.vault = new CredentialVault(join(this.stateDir, "vault.json"));
  }
  static async create(options: VideoServiceOptions = {}): Promise<VideoService> {
    const service = new VideoService(options);
    await ensurePrivateDirectory(service.stateDir);
    service.releaseLock = await acquireLock(service.stateDir);
    try {
      await service.vault.inspect();
      try {
        const raw = JSON.parse(
          await readFile(join(service.stateDir, "state.json"), "utf8"),
        ) as State;
        if (
          raw.version !== 1 ||
          !Number.isSafeInteger(raw.limitMicros) ||
          raw.limitMicros < 0 ||
          !Number.isSafeInteger(raw.perJobMicros) ||
          raw.perJobMicros < 0 ||
          !Array.isArray(raw.jobs)
        )
          throw new Error();
        for (const job of raw.jobs) {
          if (
            !uuid.safeParse(job.id).success ||
            !uuid.safeParse(job.requestId).success ||
            !Number.isFinite(job.reservedUsd) ||
            job.reservedUsd < 0 ||
            (job.outputRevision !== undefined &&
              (!Number.isSafeInteger(job.outputRevision) || job.outputRevision < 0)) ||
            ![...ACTIVE, "failed", "done"].includes(job.status)
          )
            throw new Error();
          // Version-1 state from earlier builds has no revision. Preserve its jobs and budget.
          job.outputRevision ??= 0;
          validateProcessing(job.processing);
          if (job.generation) validateGeneration(job.generation);
          if (job.status === "queued") {
            job.status = "failed";
            job.error =
              "Interrupted before dispatch. The reservation remains held; a new request must be explicit.";
          }
          if (job.status === "generating") {
            job.status = "uncertain";
            job.error = "Interrupted generation. Unlock the vault to resume known provider jobs.";
          }
        }
        service.state = raw;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("Local studio state could not be read. Existing budgets were not reset.");
      }
      await service.save();
      service.wake();
      return service;
    } catch (error) {
      await service.releaseLock();
      throw error;
    }
  }
  private async exclusive<T>(fn: () => Promise<T>, internal = false): Promise<T> {
    const check = () => {
      if (this.closed || (this.stopping && !internal)) throw new Error("Local studio is stopping.");
    };
    check();
    const execute = async () => {
      check();
      return fn();
    };
    const pending = this.chain.then(execute, execute);
    this.chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  private internal<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(fn, true);
  }
  private save(): Promise<void> {
    return writePrivateJson(join(this.stateDir, "state.json"), this.state);
  }
  private committed(): number {
    return this.state.jobs.reduce((total, job) => total + micros(job.reservedUsd), 0);
  }
  private publicJob(job: StoredJob): PublicJob {
    return {
      id: job.id,
      status: job.status,
      reservedUsd: job.reservedUsd,
      outputRevision: job.outputRevision,
      processing: validateProcessing(job.processing),
      ...(job.error ? { error: job.error } : {}),
      ...(job.artifacts ? { artifacts: { ...job.artifacts } } : {}),
    };
  }
  private findJob(id: string): StoredJob {
    if (!uuid.safeParse(id).success) throw new Error("Generation not found.");
    const job = this.state.jobs.find((job) => job.id === id);
    if (!job) throw new Error("Generation not found.");
    return job;
  }
  private requireUnlocked(): void {
    if (this.vault.locked) throw new Error("Unlock the local credential vault first.");
  }
  private requireIdle(ignoreId?: string): void {
    if (this.state.jobs.some((job) => job.id !== ignoreId && ACTIVE.has(job.status)))
      throw new Error(
        "A generation is still active or uncertain. Resolve it before starting another.",
      );
  }
  async status(): Promise<StudioStatus> {
    return this.exclusive(async () => ({
      simulation: this.options.simulation === true,
      locked: this.vault.locked,
      providers: VIDEO_PROVIDERS.map(({ id }) => ({ id, configured: this.vault.has(id) })),
      budget: {
        limitUsd: dollars(this.state.limitMicros),
        perJobUsd: dollars(this.state.perJobMicros),
        committedUsd: dollars(this.committed()),
        remainingUsd: dollars(Math.max(0, this.state.limitMicros - this.committed())),
      },
      jobs: this.state.jobs.map((job) => this.publicJob(job)),
    }));
  }
  async unlock(passphrase: string): Promise<void> {
    await this.exclusive(() => this.vault.unlock(passphrase));
    this.wake();
  }
  async lock(): Promise<void> {
    await this.exclusive(async () => {
      this.vault.lock();
      this.controller?.abort();
    });
  }
  async setCredential(provider: ProviderId, apiKey: string): Promise<void> {
    await this.exclusive(async () => {
      this.requireIdle();
      await this.vault.set(provider, apiKey);
    });
  }
  /** Metadata lookup only: does not generate media or reserve a job budget. */
  async verifyGoogleModel(model: string) {
    return this.exclusive(async () => {
      this.requireUnlocked();
      if (this.options.simulation)
        throw new Error("Model access checks are unavailable in simulation mode.");
      return verifyGoogleModel(model, this.vault.get("google"), {
        transport: this.options.transport,
        signal: AbortSignal.timeout(10_000),
      });
    });
  }
  async removeCredential(provider: ProviderId): Promise<void> {
    await this.exclusive(async () => {
      this.requireIdle();
      await this.vault.remove(provider);
    });
  }
  async setBudget(value: { limitUsd: number; perJobUsd: number }): Promise<void> {
    await this.exclusive(async () => {
      this.requireUnlocked();
      for (const amount of [value.limitUsd, value.perJobUsd]) {
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > 10_000 ||
          Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001
        )
          throw new Error("Budget limits must be whole cents between $0 and $10,000.");
      }
      if (value.perJobUsd > value.limitUsd)
        throw new Error("The per-job limit cannot exceed the total budget.");
      if (micros(value.limitUsd) < this.committed())
        throw new Error("The budget cannot be lower than committed reservations.");
      const previous = {
        limitMicros: this.state.limitMicros,
        perJobMicros: this.state.perJobMicros,
      };
      this.state.limitMicros = micros(value.limitUsd);
      this.state.perJobMicros = micros(value.perJobUsd);
      try {
        await this.save();
      } catch {
        Object.assign(this.state, previous);
        throw new Error("Budget changes could not be saved.");
      }
    });
  }
  async createJob(raw: CreateJobInput): Promise<PublicJob> {
    const idempotency = requestId(raw.requestId);
    const generation = validateGeneration(raw.generation);
    const processing = validateProcessing(raw.processing);
    resolveVideoTrim(generation.durationSeconds, processing);
    const hash = digest({ generation, processing });
    const result = await this.exclusive(async () => {
      this.requireUnlocked();
      const existing = this.state.jobs.find((job) => job.requestId === idempotency);
      if (existing) {
        if (existing.digest !== hash)
          throw new Error("This requestId was already used with different settings.");
        return this.publicJob(existing);
      }
      this.requireIdle();
      this.vault.get(generation.provider);
      const reservedUsd = estimateUsd(generation);
      const cost = micros(reservedUsd);
      if (
        cost <= 0 ||
        cost > this.state.perJobMicros ||
        this.committed() + cost > this.state.limitMicros
      )
        throw new Error("This generation exceeds the local budget. Review the limits in setup.");
      const job: StoredJob = {
        id: randomUUID(),
        requestId: idempotency,
        digest: hash,
        status: "queued",
        reservedUsd,
        outputRevision: 0,
        generation,
        processing,
      };
      await ensurePrivateDirectory(join(this.stateDir, "jobs", job.id));
      this.state.jobs.push(job);
      try {
        await this.save();
      } catch {
        this.state.jobs.pop();
        throw new Error("The generation reservation could not be saved.");
      }
      return this.publicJob(job);
    });
    this.wake();
    return result;
  }
  async importVideo(raw: ImportVideoInput): Promise<PublicJob> {
    const idempotency = requestId(raw.requestId);
    if (
      typeof raw.fileName !== "string" ||
      !/\.mp4$/i.test(raw.fileName) ||
      raw.fileName.length > 250
    )
      throw new Error("Import an MP4 video.");
    if (
      typeof raw.videoBase64 !== "string" ||
      raw.videoBase64.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4 ||
      !isBase64(raw.videoBase64)
    )
      throw new Error("Imported video exceeds the 64 MiB limit or is invalid.");
    const bytes = Buffer.from(raw.videoBase64, "base64");
    if (bytes.length > MAX_VIDEO_BYTES) throw new Error("Imported video exceeds the 64 MiB limit.");
    const mp4 = bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
    if (!mp4) throw new Error("Import a valid MP4 video.");
    const processing = validateProcessing(raw.processing);
    const hash = digest({ content: createHash("sha256").update(bytes).digest("hex"), processing });
    const result = await this.exclusive(async () => {
      const existing = this.state.jobs.find((job) => job.requestId === idempotency);
      if (existing) {
        if (existing.digest !== hash)
          throw new Error("This requestId was already used with different settings.");
        return this.publicJob(existing);
      }
      this.requireIdle();
      const job: StoredJob = {
        id: randomUUID(),
        requestId: idempotency,
        digest: hash,
        status: "processing",
        reservedUsd: 0,
        outputRevision: 0,
        processing,
        hasVideo: true,
      };
      await writePrivateFile(join(this.stateDir, "jobs", job.id, "video.mp4"), bytes);
      this.state.jobs.push(job);
      try {
        await this.save();
      } catch {
        this.state.jobs.pop();
        throw new Error("The imported job could not be saved.");
      }
      return this.publicJob(job);
    });
    this.wake();
    return result;
  }
  async job(id: string): Promise<PublicJob> {
    return this.exclusive(async () => this.publicJob(this.findJob(id)));
  }
  async retryProcessing(id: string, rawOptions?: ProcessingInput): Promise<PublicJob> {
    const result = await this.exclusive(async () => {
      const job = this.findJob(id);
      this.requireIdle(job.id);
      if (!job.hasVideo || !["failed", "done"].includes(job.status))
        throw new Error("This job has no saved video ready for processing.");
      if (rawOptions) job.processing = validateProcessing(rawOptions);
      job.status = "processing";
      job.error = undefined;
      await this.save();
      return this.publicJob(job);
    });
    this.wake();
    return result;
  }
  async resolveUncertain(id: string): Promise<PublicJob> {
    return this.exclusive(async () => {
      this.requireUnlocked();
      const job = this.findJob(id);
      if (job.status !== "uncertain" || this.task)
        throw new Error("Only a paused uncertain job can be closed.");
      job.status = "failed";
      job.error =
        "Closed explicitly after checking the provider. The full generation reservation remains committed.";
      await this.save();
      return this.publicJob(job);
    });
  }
  async artifactPath(id: string, name: string): Promise<string> {
    return this.exclusive(async () => {
      const job = this.findJob(id);
      if (
        !(artifactNames as readonly string[]).includes(name) ||
        (name === "video.mp4" ? !job.hasVideo : job.status !== "done")
      )
        throw new Error("Artifact not found.");
      const path = join(this.stateDir, "jobs", id, name as ArtifactName);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Artifact not found.");
      return path;
    });
  }
  private wake(): void {
    if (this.closed || this.stopping || this.task) return;
    const job = this.state.jobs.find(
      (job) =>
        job.status === "processing" ||
        (!this.vault.locked &&
          (job.status === "queued" ||
            ((job.status === "generating" || job.status === "uncertain") && job.operation))),
    );
    if (!job) return;
    this.controller = new AbortController();
    this.task = this.run(job.id, this.controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.task = undefined;
        this.controller = undefined;
        if (
          this.state.jobs.some((item) => item.status === "queued" || item.status === "processing")
        )
          this.wake();
      });
  }
  private async run(id: string, abort: AbortSignal): Promise<void> {
    try {
      let job = this.findJob(id);
      if (job.status !== "processing") {
        const generation = job.generation;
        if (!generation) throw new Error("Generation settings are missing.");
        const key = this.vault.get(generation.provider);
        const context = { transport: this.options.transport, signal: abort };
        if (!job.operation) {
          await this.internal(async () => {
            job.status = "generating";
            job.error = undefined;
            await this.save();
          });
          const operation = await submitGeneration(generation, key, context);
          await this.internal(async () => {
            job.operation = operation;
            await this.save();
          });
        }
        const deadline = Date.now() + (this.options.maxPollMs ?? 15 * 60_000);
        while (true) {
          if (abort.aborted || Date.now() >= deadline)
            throw new ProviderError(
              "Generation polling paused. Unlock again to resume the existing provider job.",
              true,
            );
          let status: ProviderPoll;
          try {
            status = await pollGeneration(job.operation!, key, context);
          } catch {
            if (abort.aborted)
              throw new ProviderError(
                "Generation polling paused. Unlock again to resume the existing provider job.",
                true,
              );
            await delay(this.options.pollIntervalMs ?? 5_000, undefined, { signal: abort });
            continue;
          }
          if (status.status === "failed") {
            await this.internal(async () => {
              job.status = "failed";
              job.error =
                "The provider could not generate this video. The reservation remains committed.";
              await this.save();
            });
            return;
          }
          if (status.status === "done") {
            const bytes = await downloadVideo(generation.provider, status.url, key, context);
            await writePrivateFile(join(this.stateDir, "jobs", id, "video.mp4"), bytes);
            await this.internal(async () => {
              job.hasVideo = true;
              job.status = "processing";
              job.error = undefined;
              await this.save();
            });
            break;
          }
          await delay(this.options.pollIntervalMs ?? 5_000, undefined, { signal: abort });
        }
      }
      job = this.findJob(id);
      const outputDir = join(this.stateDir, "jobs", id);
      const result = await (this.options.processVideo ?? processVideo)({
        videoPath: join(outputDir, "video.mp4"),
        outputDir,
        options: job.processing,
      });
      for (const name of artifactNames) await access(join(outputDir, name));
      await this.internal(async () => {
        job.status = "done";
        job.error = undefined;
        job.outputRevision += 1;
        job.artifacts = {
          videoPath: join(outputDir, "video.mp4"),
          sheetPath: join(outputDir, "sheet.png"),
          metadataPath: join(outputDir, "metadata.json"),
        };
        void result;
        await this.save();
      });
    } catch (error) {
      await this.internal(async () => {
        const job = this.findJob(id);
        if (job.status === "processing") {
          job.status = "failed";
          job.error =
            error instanceof VideoProcessingError
              ? error.message
              : "Video processing failed. The saved video can be processed again without another generation charge.";
        } else {
          job.status =
            error instanceof ProviderError && !error.uncertain && !job.operation
              ? "failed"
              : "uncertain";
          job.error =
            error instanceof ProviderError
              ? error.message
              : "Generation was interrupted. The reservation remains held; do not submit a duplicate.";
        }
        await this.save();
      });
    }
  }
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopping = true;
    this.controller?.abort();
    this.closeTask = (async () => {
      await this.task;
      await this.chain;
      this.closed = true;
      this.vault.lock();
      await this.releaseLock?.();
    })();
    return this.closeTask;
  }
}
export function createVideoService(options: VideoServiceOptions = {}): Promise<VideoService> {
  return VideoService.create(options);
}
