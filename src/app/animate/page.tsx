"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Download,
  Film,
  ImagePlus,
  Loader2,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  VideoLoopPreview,
  parseVideoLoopMetadata,
  type VideoLoopMetadata,
} from "@/components/video-loop-preview";
import { useSharedProjectSource } from "@/lib/project/store";
import {
  MAX_VIDEO_BYTES,
  VIDEO_MODELS,
  VIDEO_PROVIDERS,
  VIDEO_PRICING_DATE,
  estimateUsd,
  getVideoModel,
  validateGeneration,
  validateProcessing,
  type GenerationInput,
  type ProcessingOptions,
  type ProviderId,
  type VideoResolution,
} from "@/lib/video/schema";
import { resolveVideoTrim } from "@/lib/video/loop";
import {
  closeUncertainStudioJob,
  fileBase64,
  generateStudioVideo,
  importStudioVideo,
  isLocalStudio,
  retryStudioProcessing,
  studioArtifact,
  studioStatus,
  type StudioJob,
  type StudioStatus,
} from "@/lib/video/client";

type Reference = NonNullable<GenerationInput["firstFrame"]> & { name: string; id: string };
const PRESETS = [
  {
    name: "Idle",
    prompt:
      "A small red fox game character, full body, side view, gently breathing in place. One complete looping idle motion.",
  },
  {
    name: "Walk",
    prompt:
      "A small red fox game character, full body, side view, walking in place. One complete repeating walk cycle, feet return to their starting pose.",
  },
  {
    name: "Attack",
    prompt:
      "A small red fox game character, full body, side view, making one quick forward swipe and returning to its idle pose.",
  },
];
const CLEAN_PROMPT =
  " Locked camera, constant scale and framing. Keep the entire character centered with generous empty space. Solid flat chroma green #00ff00 background. No floor, shadows, texture, lighting changes, text, effects, camera movement or motion blur. Clean separated silhouette and sharp edges.";
const SELECT = "h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50";
const dollars = (value: number) => `$${value.toFixed(2)}`;

function ImageDrop({
  label,
  images,
  onChange,
  maximum = 1,
  disabled,
  reason,
}: {
  label: string;
  images: Reference[];
  onChange: (images: Reference[]) => void;
  maximum?: number;
  disabled?: boolean;
  reason?: string;
}) {
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const pick = async (files: FileList | File[]) => {
    if (disabled) return;
    setError("");
    try {
      const chosen = [...files];
      if (chosen.length === 0) return;
      if (chosen.length > maximum)
        throw new Error(`Choose at most ${maximum} image${maximum === 1 ? "" : "s"}.`);
      const refs: Reference[] = [];
      for (const file of chosen) {
        if (file.type !== "image/png" && file.type !== "image/jpeg")
          throw new Error("Use a PNG or JPEG image.");
        refs.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type,
          data: await fileBase64(file, 8 * 1024 * 1024),
        });
      }
      onChange(refs);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not read image.");
    }
  };
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <label
        className={`relative flex min-h-24 cursor-pointer items-center justify-center rounded-md border border-dashed p-3 transition-colors ${dragging ? "border-primary bg-primary/10" : "border-border hover:bg-muted/40"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void pick(event.dataTransfer.files);
        }}
      >
        <input
          aria-label={label}
          type="file"
          accept="image/png,image/jpeg"
          multiple={maximum > 1}
          disabled={disabled}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) void pick(event.target.files);
            event.target.value = "";
          }}
        />
        {images.length ? (
          <div className="flex flex-wrap justify-center gap-2">
            {images.map((item) => (
              <img
                key={item.id}
                src={`data:${item.mimeType};base64,${item.data}`}
                alt={item.name}
                className="h-20 max-w-28 rounded object-contain"
              />
            ))}
          </div>
        ) : (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <ImagePlus className="h-4 w-4" />
            Drop or choose {maximum > 1 ? `up to ${maximum} images` : "an image"}
          </span>
        )}
      </label>
      {images.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear {label.toLowerCase()}
        </button>
      )}
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default function AnimatePage() {
  const [local, setLocal] = useState(false);
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("xai");
  const [modelId, setModelId] = useState("grok-imagine-video-1.5-lite");
  const [prompt, setPrompt] = useState(PRESETS[0].prompt + CLEAN_PROMPT);
  const [duration, setDuration] = useState(2);
  const [resolution, setResolution] = useState<VideoResolution>("720p");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [firstFrame, setFirstFrame] = useState<Reference[]>([]);
  const [lastFrame, setLastFrame] = useState<Reference[]>([]);
  const [references, setReferences] = useState<Reference[]>([]);
  const [processing, setProcessing] = useState<ProcessingOptions>(() => validateProcessing({}));
  const [jobId, setJobId] = useState<string | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [sheetPreview, setSheetPreview] = useState<string | null>(null);
  const [loopMetadata, setLoopMetadata] = useState<VideoLoopMetadata | null>(null);
  const [handoffReady, setHandoffReady] = useState(false);
  const pendingRequest = useRef<{ signature: string; id: string } | null>(null);
  const { setSharedSource } = useSharedProjectSource();
  const model = getVideoModel(modelId);
  const current = status?.jobs.find((job) => job.id === jobId) ?? null;
  const configured = status?.providers.find((item) => item.id === provider)?.configured;
  const refresh = useCallback(async () => {
    try {
      setStatus(await studioStatus());
      setConnectionError("");
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : "Could not connect to Video Studio.",
      );
    }
  }, []);

  useEffect(() => {
    setLocal(isLocalStudio());
    if (!isLocalStudio()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed MCP reprocess changes the revision even if polling misses its transient processing status
  useEffect(() => {
    setVideoPreview(null);
    setSheetPreview(null);
    setLoopMetadata(null);
    setHandoffReady(false);
    if (current?.status !== "done") return;
    let active = true;
    const urls: string[] = [];
    void Promise.all([
      studioArtifact(current.id, "video.mp4"),
      studioArtifact(current.id, "sheet.png"),
      studioArtifact(current.id, "metadata.json").then(async (blob) =>
        parseVideoLoopMetadata(JSON.parse(await blob.text())),
      ),
    ])
      .then(([video, sheet, metadata]) => {
        if (!active) return;
        const v = URL.createObjectURL(video),
          s = URL.createObjectURL(sheet);
        urls.push(v, s);
        setVideoPreview(v);
        setSheetPreview(s);
        setLoopMetadata(metadata);
      })
      .catch(() => {
        if (active) setError("Could not load output preview. Try selecting the job again.");
      });
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [current?.id, current?.status, current?.outputRevision]);

  const generation: GenerationInput = {
    provider,
    model: modelId,
    prompt,
    durationSeconds: duration,
    resolution,
    aspectRatio,
    firstFrame: firstFrame[0] && { mimeType: firstFrame[0].mimeType, data: firstFrame[0].data },
    lastFrame: lastFrame[0] && { mimeType: lastFrame[0].mimeType, data: lastFrame[0].data },
    referenceImages: references.length
      ? references.map(({ mimeType, data }) => ({ mimeType, data }))
      : undefined,
  };
  let estimate = 0;
  let validation = "";
  try {
    estimate = estimateUsd(generation);
    resolveVideoTrim(duration, validateProcessing(processing));
  } catch (error) {
    validation = error instanceof Error ? error.message : "Check the selected controls.";
  }
  const overBudget =
    !!status && (estimate > status.budget.perJobUsd || estimate > status.budget.remainingUsd);
  const activeJob = status?.jobs.some((job) =>
    ["queued", "generating", "processing", "uncertain"].includes(job.status),
  );
  const ready = local && !!status && !status.locked && !busy;

  const chooseModel = (id: string) => {
    const next = getVideoModel(id);
    setModelId(id);
    setProvider(next.provider);
    setDuration(next.provider === "xai" ? 2 : 4);
    setResolution(next.resolutions.includes("720p") ? "720p" : next.resolutions[0]);
    setAspectRatio(next.aspectRatios.includes("16:9") ? "16:9" : next.aspectRatios[0]);
    if (!next.supportsLastFrame) setLastFrame([]);
    setReferences((value) => value.slice(0, next.maxReferenceImages));
    setError("");
  };
  const acceptJob = async (job: StudioJob) => {
    setJobId(job.id);
    setStatus(
      (previous) =>
        previous && {
          ...previous,
          jobs: [job, ...previous.jobs.filter((item) => item.id !== job.id)],
        },
    );
    await refresh();
  };
  const generate = async () => {
    setError("");
    setBusy(true);
    try {
      const input = validateGeneration(generation);
      const outputSettings = validateProcessing(processing);
      resolveVideoTrim(input.durationSeconds, outputSettings);
      const signature = JSON.stringify({ generation: input, processing: outputSettings });
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = { signature, id: crypto.randomUUID() };
      const job = await generateStudioVideo(pendingRequest.current.id, input, outputSettings);
      pendingRequest.current = null;
      await acceptJob(job);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Generation request failed.");
    } finally {
      setBusy(false);
    }
  };
  const importVideo = async (file: File) => {
    setError("");
    setBusy(true);
    try {
      if (!/\.mp4$/i.test(file.name) || (await file.slice(4, 8).text()) !== "ftyp") {
        throw new Error("Choose an MP4 video file. Convert WebM files to MP4 before importing.");
      }
      const videoBase64 = await fileBase64(file, MAX_VIDEO_BYTES);
      await acceptJob(
        await importStudioVideo(
          crypto.randomUUID(),
          file.name,
          videoBase64,
          validateProcessing(processing),
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };
  const reprocess = async (options = processing) => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      // The companion probes this saved video's actual duration; the generation form may describe a different clip.
      await acceptJob(await retryStudioProcessing(current.id, validateProcessing(options)));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Processing failed.");
    } finally {
      setBusy(false);
    }
  };
  const closeUncertain = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await acceptJob(await closeUncertainStudioJob(current.id));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not close this uncertain job.");
    } finally {
      setBusy(false);
    }
  };
  const download = async (name: "video.mp4" | "sheet.png" | "metadata.json") => {
    if (!current) return;
    try {
      const url = URL.createObjectURL(await studioArtifact(current.id, name));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Download failed.");
    }
  };
  const handoff = async () => {
    if (!current) return;
    try {
      await setSharedSource(
        new File([await studioArtifact(current.id, "sheet.png")], "sheet.png", {
          type: "image/png",
        }),
      );
      setHandoffReady(true);
    } catch {
      setError("Could not save the sheet for the other sprite tools.");
    }
  };
  const updateProcessing = (key: keyof ProcessingOptions, value: string | number) =>
    setProcessing((previous) => ({ ...previous, [key]: value }));

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Video Studio</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Generate a motion clip. Cut the background. Export a sprite sheet with collision
            polygons and frame timing.
          </p>
        </div>
        {local && (
          <a href="/setup" className="flex items-center gap-2 text-sm underline underline-offset-4">
            <Settings2 className="h-4 w-4" />
            Keys &amp; limits
          </a>
        )}
      </header>
      {status?.simulation && (
        <p
          role="status"
          className="mb-6 rounded-md border border-primary/30 bg-primary/10 p-4 text-sm font-medium"
        >
          Offline test: provider responses are simulated. No API charges. Imported videos are
          processed normally.
        </p>
      )}
      {!local ? (
        <section className="mb-8 space-y-3 rounded-md bg-muted/40 p-5">
          <h2 className="font-medium">Start your local studio</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Run the companion, then open its private setup link. Your Google and xAI keys stay in an
            encrypted vault on your computer. The same studio serves the Web and MCP tools.
          </p>
          <code className="block select-all text-sm">sprite-tools studio</code>
          <p className="text-xs text-muted-foreground">
            Requires the installed sprite-tools package, ffmpeg and ffprobe.{" "}
            <Link href="/docs/mcp/install" className="underline">
              Setup instructions
            </Link>
          </p>
        </section>
      ) : connectionError ? (
        <div role="alert" className="mb-6 space-y-2 rounded-md bg-muted/40 p-4 text-sm">
          <p>{connectionError}</p>
          <a href="/setup" className="underline">
            Open local setup
          </a>
          <button type="button" onClick={() => void refresh()} className="ml-4 underline">
            Reconnect
          </button>
        </div>
      ) : status?.locked ? (
        <div className="mb-6 rounded-md bg-muted/40 p-4 text-sm">
          Unlock your local vault in{" "}
          <a href="/setup" className="underline">
            Keys &amp; limits
          </a>{" "}
          to generate videos.
        </div>
      ) : null}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="space-y-6" aria-label="Generation settings">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="video-provider">Provider</Label>
              <select
                id="video-provider"
                className={SELECT}
                value={provider}
                onChange={(event) =>
                  chooseModel(
                    event.target.value === "google"
                      ? "veo-3.1-lite-generate-preview"
                      : "grok-imagine-video-1.5-lite",
                  )
                }
              >
                {VIDEO_PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="video-model">Model</Label>
              <select
                id="video-model"
                className={SELECT}
                value={modelId}
                onChange={(event) => chooseModel(event.target.value)}
              >
                {VIDEO_MODELS.filter((item) => item.provider === provider).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-3">
            <Label htmlFor="video-prompt">Character and motion</Label>
            <div className="flex gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => setPrompt(preset.prompt + CLEAN_PROMPT)}
                  className="rounded border px-3 py-1 text-xs transition-colors hover:bg-muted"
                >
                  {preset.name} example
                </button>
              ))}
            </div>
            <Textarea
              id="video-prompt"
              rows={7}
              maxLength={8000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="resize-y text-sm leading-relaxed"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ImageDrop
              label="Start frame"
              images={firstFrame}
              onChange={setFirstFrame}
              disabled={provider === "google" && references.length > 0}
              reason={
                provider === "google" && references.length > 0
                  ? "Clear references to use start/end frames."
                  : "Optional. Leave empty for text to video."
              }
            />
            <ImageDrop
              label="End frame"
              images={lastFrame}
              onChange={setLastFrame}
              disabled={
                !model.supportsLastFrame ||
                (provider === "google" && (references.length > 0 || firstFrame.length === 0))
              }
              reason={
                !model.supportsLastFrame
                  ? "This model has no end-frame control."
                  : provider === "google" && firstFrame.length === 0
                    ? "Add a start frame first."
                    : "Optional target ending pose."
              }
            />
          </div>
          <ImageDrop
            label="Reference images"
            images={references}
            onChange={setReferences}
            maximum={model.maxReferenceImages || 1}
            disabled={
              !model.maxReferenceImages ||
              (provider === "google" && (firstFrame.length > 0 || lastFrame.length > 0))
            }
            reason={
              !model.maxReferenceImages
                ? "This model has no reference-image control."
                : provider === "google"
                  ? "Use references or start/end frames. References require 8 seconds."
                  : "Keep the character consistent. References support up to 720p."
            }
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="video-duration">Seconds</Label>
              <select
                id="video-duration"
                className={SELECT}
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              >
                {(
                  model.durations ??
                  Array.from(
                    { length: model.maxDuration - model.minDuration + 1 },
                    (_, index) => index + model.minDuration,
                  )
                ).map((seconds) => (
                  <option
                    key={seconds}
                    value={seconds}
                    disabled={
                      provider === "google" &&
                      (references.length > 0 || resolution === "1080p") &&
                      seconds !== 8
                    }
                  >
                    {seconds}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="video-resolution">Resolution</Label>
              <select
                id="video-resolution"
                className={SELECT}
                value={resolution}
                onChange={(event) => setResolution(event.target.value as VideoResolution)}
              >
                {model.resolutions.map((item) => (
                  <option
                    key={item}
                    value={item}
                    disabled={
                      provider === "xai" &&
                      (references.length > 0 || lastFrame.length > 0) &&
                      item === "1080p"
                    }
                  >
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="video-aspect">Aspect</Label>
              <select
                id="video-aspect"
                className={SELECT}
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.target.value)}
              >
                {model.aspectRatios.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <section className="space-y-4 border-t pt-5" aria-label="Trim and loop settings">
            <div>
              <h2 className="text-sm font-medium">Trim &amp; loop</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Keep the useful motion, find a repeating cycle, then reduce the frame count.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="loop-start" className="text-xs">
                  Start (seconds)
                </Label>
                <Input
                  id="loop-start"
                  type="number"
                  min={0}
                  max={30}
                  step={0.05}
                  value={processing.startSeconds}
                  onChange={(event) =>
                    setProcessing((previous) => ({
                      ...previous,
                      startSeconds: Number(event.target.value),
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="loop-end" className="text-xs">
                  End (seconds)
                </Label>
                <Input
                  id="loop-end"
                  type="number"
                  min={0.05}
                  max={30}
                  step={0.05}
                  placeholder="Video end"
                  value={processing.endSeconds ?? ""}
                  onChange={(event) =>
                    setProcessing((previous) => ({
                      ...previous,
                      endSeconds:
                        event.target.value === "" ? undefined : Number(event.target.value),
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="loop-budget" className="text-xs">
                  Frame budget
                </Label>
                <Input
                  id="loop-budget"
                  type="number"
                  min={2}
                  max={120}
                  placeholder="Up to 120"
                  value={processing.maxFrames ?? ""}
                  onChange={(event) =>
                    setProcessing((previous) => ({
                      ...previous,
                      maxFrames: event.target.value === "" ? undefined : Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={processing.loopMode === "auto"}
                onChange={(event) =>
                  setProcessing((previous) => ({
                    ...previous,
                    loopMode: event.target.checked ? "auto" : "full",
                  }))
                }
              />
              Suggest a repeating loop
            </label>
            {processing.loopMode === "auto" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="loop-min" className="text-xs">
                    Shortest loop (seconds)
                  </Label>
                  <Input
                    id="loop-min"
                    type="number"
                    min={0.1}
                    max={30}
                    step={0.1}
                    value={processing.loopMinSeconds}
                    onChange={(event) =>
                      setProcessing((previous) => ({
                        ...previous,
                        loopMinSeconds: Number(event.target.value),
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="loop-max" className="text-xs">
                    Longest loop (seconds)
                  </Label>
                  <Input
                    id="loop-max"
                    type="number"
                    min={0.1}
                    max={30}
                    step={0.1}
                    value={processing.loopMaxSeconds}
                    onChange={(event) =>
                      setProcessing((previous) => ({
                        ...previous,
                        loopMaxSeconds: Number(event.target.value),
                      }))
                    }
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="loop-dedupe" className="text-xs">
                Adjacent duplicate tolerance
              </Label>
              <Input
                id="loop-dedupe"
                type="number"
                min={0}
                max={8}
                step={0.5}
                placeholder="Off"
                value={processing.dedupeThreshold ?? ""}
                onChange={(event) =>
                  setProcessing((previous) => ({
                    ...previous,
                    dedupeThreshold:
                      event.target.value === "" ? undefined : Number(event.target.value),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Blank keeps every sampled frame. 0 merges exact adjacent duplicates; higher values
                merge similar frames. Removed frames become hold time.
              </p>
            </div>
            {current && (current.status === "done" || current.status === "failed") && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!ready}
                  onClick={() => void reprocess()}
                >
                  <RefreshCw className="mr-2 h-3 w-3" />
                  Apply to saved video · free
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!ready}
                  onClick={() => {
                    const options = { ...processing, loopMode: "auto" as const };
                    setProcessing(options);
                    void reprocess(options);
                  }}
                >
                  Suggest loop from saved video
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Automatic loops are suggestions. Review the preview and seam. Reprocessing uses the
              saved video and makes no provider request.
            </p>
          </section>
          <details className="border-y py-4" open>
            <summary className="cursor-pointer text-sm font-medium">Sprite output</summary>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {(
                [
                  ["fps", "Sample FPS", 1, 24],
                  ["frameWidth", "Frame width", 16, 512],
                  ["columns", "Columns", 1, 32],
                  ["tolerance", "Key tolerance", 0, 255],
                  ["padding", "Crop padding", 0, 32],
                ] as const
              ).map(([key, title, min, max]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`output-${key}`} className="text-xs">
                    {title}
                  </Label>
                  <Input
                    id={`output-${key}`}
                    type="number"
                    min={min}
                    max={max}
                    value={processing[key]}
                    onChange={(event) => updateProcessing(key, Number(event.target.value))}
                  />
                </div>
              ))}
              <div className="space-y-2">
                <Label htmlFor="output-background" className="text-xs">
                  Background
                </Label>
                <input
                  id="output-background"
                  type="color"
                  value={processing.backgroundColor}
                  onChange={(event) => updateProcessing("backgroundColor", event.target.value)}
                  className="h-9 w-full rounded border bg-background p-1"
                />
              </div>
              <div className="col-span-3 space-y-2">
                <Label htmlFor="output-name" className="text-xs">
                  Animation name
                </Label>
                <Input
                  id="output-name"
                  value={processing.name}
                  onChange={(event) => updateProcessing("name", event.target.value)}
                  maxLength={80}
                />
              </div>
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Edge cleanup
              </summary>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {(
                  [
                    ["softness", "Soft edge", 100],
                    ["spill", "Color spill", 150],
                    ["choke", "Erode pixels", 5],
                  ] as const
                ).map(([key, title, max]) => (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`output-${key}`} className="text-xs">
                      {title}
                    </Label>
                    <Input
                      id={`output-${key}`}
                      type="number"
                      min={0}
                      max={max}
                      value={processing[key]}
                      onChange={(event) => updateProcessing(key, Number(event.target.value))}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Increase tolerance or edge cleanup for compressed green fringes. Erosion can remove
                thin features; inspect the preview.
              </p>
            </details>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Up to 120 frames. One shared crop keeps the character aligned. Transparent PNG,
              per-frame full-body bounding hitboxes and silhouette polygons, bottom-center pivots,
              timing and animation tag.
            </p>
          </details>
          <div className="space-y-3">
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {duration} s · {resolution} · estimated {dollars(estimate)} USD
              </span>
              {status && (
                <span>
                  {dollars(status.budget.remainingUsd)} remaining ·{" "}
                  {dollars(status.budget.perJobUsd)} / job limit
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              480p for rough drafts. 720p is the default.
            </p>
            <p className="text-[11px] text-muted-foreground">
              List prices checked {VIDEO_PRICING_DATE}. Provider billing can differ. Local budget
              stays reserved after uncertain requests.
            </p>
            {validation && <p className="text-xs text-destructive">{validation}</p>}
            {overBudget && (
              <p className="text-xs text-destructive">
                This request exceeds your local budget. Change the model, duration or limits.
              </p>
            )}
            {local && status && !configured && (
              <p className="text-xs text-muted-foreground">
                Add this provider&apos;s key in{" "}
                <a href="/setup" className="underline">
                  Keys &amp; limits
                </a>
                .
              </p>
            )}
            <Button
              className="w-full"
              disabled={!ready || !configured || !!validation || overBudget || !!activeJob}
              onClick={() => void generate()}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Film className="mr-2 h-4 w-4" />
              )}
              Generate video &amp; sprite sheet
            </Button>
            {activeJob && (
              <p className="text-xs text-muted-foreground">
                Finish the active job before starting another generation. An uncertain request keeps
                its reservation.
              </p>
            )}
            <label
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted ${!ready || activeJob ? "pointer-events-none opacity-50" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file && ready && !activeJob) void importVideo(file);
              }}
            >
              <input
                aria-label="Import existing video"
                type="file"
                accept="video/mp4,.mp4"
                disabled={!ready || !!activeJob}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importVideo(file);
                  event.target.value = "";
                }}
              />
              Import or drop an MP4 video · no API cost
            </label>
          </div>
        </section>
        <section className="min-w-0 space-y-6" aria-label="Video output">
          <div className="overflow-hidden rounded-lg bg-muted/30">
            {videoPreview ? (
              <video
                aria-label="Generated video"
                src={videoPreview}
                controls
                muted
                playsInline
                loop
                className="aspect-video w-full object-contain"
              />
            ) : (
              <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                {current && ["queued", "generating", "processing"].includes(current.status) ? (
                  <Loader2 className="h-8 w-8 animate-spin" />
                ) : (
                  <Film className="h-10 w-10 opacity-30" />
                )}
                <p className="text-sm">
                  {current ? `Job ${current.status}` : "Your video and sprite sheet appear here"}
                </p>
                <p className="max-w-sm text-xs">
                  {current?.status === "generating"
                    ? "Generation can take several minutes. You can return to this job after reloading."
                    : "Start from text, concept art, or a saved video."}
                </p>
              </div>
            )}
          </div>
          {sheetPreview && loopMetadata && (
            <VideoLoopPreview sheetUrl={sheetPreview} metadata={loopMetadata} />
          )}
          {sheetPreview && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium">Transparent sprite sheet</h2>
              <div className="max-h-96 overflow-auto rounded border bg-[repeating-conic-gradient(#8882_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
                <img
                  src={sheetPreview}
                  alt="Processed sprite sheet with the background removed"
                  className="mx-auto max-w-full [image-rendering:pixelated]"
                />
              </div>
            </div>
          )}
          {current?.status === "done" && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["sheet.png", "Sheet PNG"],
                    ["metadata.json", "Metadata JSON"],
                    ["video.mp4", "Original video"],
                  ] as const
                ).map(([name, title]) => (
                  <Button
                    key={name}
                    variant="outline"
                    size="sm"
                    onClick={() => void download(name)}
                  >
                    <Download className="mr-2 h-3 w-3" />
                    {title}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Bounding hitboxes include every visible part. Collision polygons follow the first
                connected silhouette; detached parts and holes need manual adjustment. Review both
                for gameplay.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/spritesheet?videoJob=${encodeURIComponent(current.id)}`}
                  className="flex items-center gap-1 text-sm underline"
                >
                  Open video in Sheet Builder <ArrowRight className="h-3 w-3" />
                </Link>
                <Button variant="outline" size="sm" onClick={() => void handoff()}>
                  Use sheet in other tools
                </Button>
                {handoffReady && (
                  <Link href="/collision" className="flex items-center gap-1 text-sm underline">
                    Review collision <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          )}
          {current?.status === "uncertain" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Check the provider console before starting another generation; the previous request
                may still finish and be billed.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={!ready}
                onClick={() => void closeUncertain()}
              >
                Close uncertain job (keep reserved cost)
              </Button>
            </div>
          )}
          {(error || current?.error) && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error || current?.error}
            </p>
          )}
          <div className="border-t pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Saved jobs</h2>
              {local && (
                <button type="button" className="text-xs underline" onClick={() => void refresh()}>
                  Refresh
                </button>
              )}
            </div>
            {status?.jobs.length ? (
              <ul className="divide-y">
                {status.jobs.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setProcessing(validateProcessing(job.processing));
                        setJobId(job.id);
                        setError("");
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-2 py-3 text-left text-xs transition-colors hover:bg-muted/40 ${jobId === job.id ? "bg-muted/40" : ""}`}
                    >
                      <span className="font-mono">{job.id.slice(0, 8)}</span>
                      <span>{job.status}</span>
                      <span className="text-muted-foreground">{dollars(job.reservedUsd)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No jobs in this local studio yet.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
