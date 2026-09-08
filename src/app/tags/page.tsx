"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
  Pause,
  Play,
  Plus,
  Tags as TagsIcon,
  Timer,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  type FrameDurations,
  fpsToDurationMs,
  normalizeFrameDurations,
  resolveFrameDurationMs,
  resolveSequenceDurationsMs,
  totalDurationMs,
} from "@/lib/animation/durations";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";

interface TagFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  imageData: ImageData;
}

type Direction = "forward" | "reverse" | "pingpong";

interface Tag {
  id: string;
  name: string;
  from: number;
  to: number;
  direction: Direction;
  fps: number;
}

type SourceMode = "single" | "sheet";

async function frameToImageData(frame: Frame): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  return ctx.getImageData(0, 0, frame.width, frame.height);
}

function newTagId(): string {
  return `t${Math.random().toString(36).slice(2, 9)}`;
}

// Frame indices a tag plays, in order. Shared by playback and the per-tag
// total-duration readout so both agree on what pingpong actually costs.
function tagSequence(tag: Tag, frameCount: number): number[] {
  if (frameCount === 0) return [];
  const lo = Math.max(0, Math.min(tag.from, tag.to));
  const hi = Math.min(frameCount - 1, Math.max(tag.from, tag.to));
  if (hi < lo) return [];
  const fwd = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  if (tag.direction === "reverse") return [...fwd].reverse();
  if (tag.direction === "pingpong") return [...fwd, ...fwd.slice(1, -1).reverse()];
  return fwd;
}

// Durations are stored one-per-frame globally, so the array has to track the
// frame count: pad with `null` (inherit the tag's fps), truncate what is gone.
function resizeDurations(prev: FrameDurations, frameCount: number): FrameDurations {
  const next: FrameDurations = new Array(frameCount).fill(null);
  for (let i = 0; i < Math.min(prev.length, frameCount); i++) next[i] = prev[i];
  return next;
}

export default function TagsPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("sheet");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<TagFrame[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  // One entry per frame; `null` = inherit the playing tag's fps.
  const [frameDurations, setFrameDurations] = useState<FrameDurations>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDownloaded, setHasDownloaded] = useState(false);

  // Playback state
  const [playingTagId, setPlayingTagId] = useState<string | null>(null);
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [globalFps, setGlobalFps] = useState(10);
  const playbackRef = useRef<number | null>(null);

  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewport = useViewport();
  const { view, containerRef: previewContainerRef, baseView } = viewport;
  const hasAutoFittedRef = useRef(false);

  const effectiveCols = sourceMode === "single" ? 1 : Math.max(1, sheetCols);
  const effectiveRows = sourceMode === "single" ? 1 : Math.max(1, sheetRows);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Please upload an image.");
        return;
      }
      await setSharedSource(file);
      setCurrentIndex(0);
      setTags([]);
      setFrameDurations([]);
      hasAutoFittedRef.current = false;

      try {
        const det = await detectSheetGrid(file);
        if (det.confidence > 0 && (det.cols > 1 || det.rows > 1)) {
          setSourceMode("sheet");
          setSheetCols(det.cols);
          setSheetRows(det.rows);
          setDetectedGrid({ cols: det.cols, rows: det.rows });
          toast.success(`Detected ${det.cols}×${det.rows} grid`);
        } else {
          setSourceMode("single");
          setSheetCols(1);
          setSheetRows(1);
          setDetectedGrid(null);
        }
      } catch {
        setSourceMode("single");
        setSheetCols(1);
        setSheetRows(1);
        setDetectedGrid(null);
      }
    },
    [setSharedSource],
  );

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFile(f);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (item?.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) void handleFile(f);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  // -----------------------------------------------------------------
  // Slice source
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!sourceFile) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsProcessing(true);
      setError(null);
      try {
        const sliced = await importFromSpriteSheet(sourceFile, {
          cols: effectiveCols,
          rows: effectiveRows,
        });
        if (cancelled) return;
        const out: TagFrame[] = [];
        for (const f of sliced.frames) {
          out.push({
            index: out.length,
            width: f.width,
            height: f.height,
            cellRow: f.metadata?.cellRow,
            cellCol: f.metadata?.cellCol,
            imageData: await frameToImageData(f),
          });
        }
        if (cancelled) return;
        setFrames(out);
        setCurrentIndex(0);
        hasAutoFittedRef.current = false;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          toast.error("Failed to slice source");
        }
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceFile, effectiveCols, effectiveRows]);

  // -----------------------------------------------------------------
  // Frame durations
  // -----------------------------------------------------------------
  // Re-slicing the sheet (different cols/rows) changes the frame count; keep
  // the durations array the same length so index i always means frame i.
  useEffect(() => {
    setFrameDurations((prev) =>
      prev.length === frames.length ? prev : resizeDurations(prev, frames.length),
    );
  }, [frames.length]);

  // A re-slice can shrink the sheet under existing tags; clamp their ranges so
  // no tag points past the last frame.
  useEffect(() => {
    if (frames.length === 0) return;
    const last = frames.length - 1;
    setTags((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const from = Math.max(0, Math.min(last, t.from));
        const to = Math.max(0, Math.min(last, t.to));
        if (from === t.from && to === t.to) return t;
        changed = true;
        return { ...t, from, to };
      });
      return changed ? next : prev;
    });
  }, [frames.length]);

  const setRangeDuration = useCallback(
    (from: number, to: number, ms: number | null) => {
      setFrameDurations((prev) => {
        const next = resizeDurations(prev, frames.length);
        const lo = Math.max(0, Math.min(from, to));
        const hi = Math.min(frames.length - 1, Math.max(from, to));
        // Round first: a sub-millisecond hold rounds to 0, which is not a
        // duration — store it as null (auto) rather than a bogus explicit 0.
        const rounded = ms !== null && Number.isFinite(ms) ? Math.round(ms) : null;
        const value = rounded !== null && rounded > 0 ? rounded : null;
        for (let i = lo; i <= hi; i++) next[i] = value;
        return next;
      });
    },
    [frames.length],
  );

  const setFrameDuration = useCallback(
    (index: number, ms: number | null) => setRangeDuration(index, index, ms),
    [setRangeDuration],
  );

  // -----------------------------------------------------------------
  // Canvas render
  // -----------------------------------------------------------------
  const currentFrame = frames[currentIndex];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentFrame) return;
    canvas.width = currentFrame.width;
    canvas.height = currentFrame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(currentFrame.imageData, 0, 0);
  }, [currentFrame]);

  // -----------------------------------------------------------------
  // Playback
  // -----------------------------------------------------------------
  // Build the sequence of frame indices for the active playback.
  const playbackSequence = useMemo<number[]>(() => {
    if (isPlayingAll && frames.length > 0) {
      return Array.from({ length: frames.length }, (_, i) => i);
    }
    if (playingTagId) {
      const t = tags.find((x) => x.id === playingTagId);
      if (!t) return [];
      return tagSequence(t, frames.length);
    }
    return [];
  }, [isPlayingAll, playingTagId, tags, frames.length]);

  const playbackFps = useMemo(() => {
    if (isPlayingAll) return globalFps;
    const t = tags.find((x) => x.id === playingTagId);
    return t?.fps ?? globalFps;
  }, [isPlayingAll, playingTagId, tags, globalFps]);

  // Hold time for every step of the sequence. With no explicit durations every
  // entry is fpsToDurationMs(playbackFps), i.e. the old uniform interval.
  const playbackDelays = useMemo(
    () => resolveSequenceDurationsMs(playbackSequence, frameDurations, playbackFps),
    [playbackSequence, frameDurations, playbackFps],
  );

  useEffect(() => {
    if (playbackSequence.length === 0) {
      if (playbackRef.current !== null) {
        window.clearTimeout(playbackRef.current);
        playbackRef.current = null;
      }
      return;
    }
    // Step through the sequence, scheduling each step by the hold time of the
    // frame currently on screen. Keep currentIndex in sync.
    let step = 0;
    // Start from where the tag begins rather than continuing a stale index
    setCurrentIndex(playbackSequence[0]);
    const schedule = () => {
      const delay = Math.max(16, Math.round(playbackDelays[step] ?? 100));
      playbackRef.current = window.setTimeout(() => {
        step = (step + 1) % playbackSequence.length;
        setCurrentIndex(playbackSequence[step]);
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      if (playbackRef.current !== null) {
        window.clearTimeout(playbackRef.current);
        playbackRef.current = null;
      }
    };
  }, [playbackSequence, playbackDelays]);

  const stopPlayback = () => {
    setPlayingTagId(null);
    setIsPlayingAll(false);
  };

  // Which rate an "auto" frame inherits right now: the playing tag, else the
  // first tag whose range covers the current frame, else the global default.
  const timingTag = useMemo(() => {
    if (playingTagId) return tags.find((t) => t.id === playingTagId) ?? null;
    return (
      tags.find(
        (t) => currentIndex >= Math.min(t.from, t.to) && currentIndex <= Math.max(t.from, t.to),
      ) ?? null
    );
  }, [playingTagId, tags, currentIndex]);
  const timingFps = timingTag?.fps ?? globalFps;
  const timingBaseMs = fpsToDurationMs(timingFps);
  const currentDurationMs = resolveFrameDurationMs(frameDurations, currentIndex, timingFps);
  const currentExplicitMs = frameDurations[currentIndex] ?? null;
  const heldCount = frameDurations.reduce<number>((n, d) => (d === null ? n : n + 1), 0);

  // -----------------------------------------------------------------
  // Viewport
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!currentFrame || hasAutoFittedRef.current) return;
    if (!previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(currentFrame.width, currentFrame.height);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [currentFrame, previewContainerRef, viewport]);

  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewport.handleWheel(e, el);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, previewContainerRef]);

  // -----------------------------------------------------------------
  // Tag CRUD
  // -----------------------------------------------------------------
  const addTag = () => {
    if (frames.length === 0) return;
    const from = currentIndex;
    const to = Math.min(frames.length - 1, currentIndex + 3);
    setTags((prev) => [
      ...prev,
      {
        id: newTagId(),
        name: `clip${prev.length + 1}`,
        from,
        to,
        direction: "forward",
        fps: globalFps,
      },
    ]);
  };

  const updateTag = (id: string, patch: Partial<Tag>) => {
    setTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const deleteTag = (id: string) => {
    setTags((prev) => prev.filter((t) => t.id !== id));
    if (playingTagId === id) stopPlayback();
  };

  const setRangeFromCurrent = (id: string, which: "from" | "to") => {
    updateTag(id, { [which]: currentIndex });
  };

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  // Same shape as `sprite-tools tags` CLI output.
  const jsonPayload = useMemo(() => {
    if (frames.length === 0 || !sourceFile) return null;
    const f0 = frames[0];
    // Omitted entirely when no frame has an explicit hold, so a sheet that
    // never touches durations exports byte-identical JSON to before.
    const durations = normalizeFrameDurations(frameDurations, frames.length);
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      frameCount: frames.length,
      ...(durations ? { frameDurations: durations } : {}),
      tags: tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        fps: t.fps,
      })),
    };
  }, [frames, tags, frameDurations, sourceFile, sourceMode, sheetCols, sheetRows]);

  const downloadJson = () => {
    if (!jsonPayload || !sourceFile) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-tags.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Animation JSON downloaded");
    setHasDownloaded(true);
  };

  const copyJson = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
      toast.success("Copied to clipboard");
      setHasDownloaded(true);
    } catch {
      toast.error("Copy failed");
    }
  };

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        label: "Upload a sprite sheet",
        hint: "Drop a sprite sheet — frames appear in the grid below.",
        done: !!sourceUrl,
      },
      {
        label: "Define animation tags",
        hint: "Name each clip (idle, run, attack) and set its frame range + FPS.",
        done: tags.length > 0,
      },
      {
        label: "Hold your key poses",
        hint: "Give a frame its own hold in ms — the rest inherit the tag's FPS.",
        done: heldCount > 0,
      },
      {
        label: "Download tags JSON",
        hint: "Save the Aseprite-compatible tags JSON.",
        done: hasDownloaded,
      },
    ],
    [sourceUrl, tags.length, heldCount, hasDownloaded],
  );
  const tutorial = useTutorial({ id: "tags", steps: tutorialSteps });

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Tags"
        description="Split a sheet into named clips — idle, run, jump — and export Aseprite-style JSON."
        icon={TagsIcon}
        category="metadata"
        docs="tags"
      />
      <TutorialStrip
        open={tutorial.isOpen}
        steps={tutorialSteps}
        currentStep={tutorial.currentStep}
        onDismiss={tutorial.dismiss}
        onPrev={tutorial.goPrev}
        onNext={tutorial.goNext}
        onStepClick={tutorial.setCurrentStep}
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Sprite sheet with animation frames.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: file drop zone — click forwards to nested <input type="file">; keyboard a11y tracked separately */}
              <div
                className={cn(
                  "border-2 border-dashed rounded-lg overflow-hidden flex flex-col items-center justify-center cursor-pointer transition-colors relative",
                  isDragging && "border-primary bg-primary/10",
                  sourceUrl
                    ? "border-primary/50 aspect-video"
                    : "border-muted-foreground/20 hover:border-primary/50 p-6",
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
              >
                {sourceUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={sourceUrl}
                    alt="source"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <div className="text-center">
                    <Upload className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
                    <p className="text-sm text-muted-foreground">Upload / drop / paste</p>
                  </div>
                )}
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onFileInputChange}
                />
              </div>
              <SampleSprites />
              {sourceUrl && (
                <>
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/30 border">
                    {[
                      { id: "single" as const, label: "Single", Icon: ImageIcon },
                      { id: "sheet" as const, label: "Sheet", Icon: Grid3x3 },
                    ].map(({ id, label, Icon }) => (
                      <button
                        type="button"
                        key={id}
                        onClick={() => {
                          setSourceMode(id);
                          if (id === "single") {
                            setSheetCols(1);
                            setSheetRows(1);
                          }
                        }}
                        className={cn(
                          "flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors",
                          sourceMode === id
                            ? "bg-background shadow-sm text-primary"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                  {sourceMode === "sheet" && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Columns</Label>
                          <Input
                            type="number"
                            min={1}
                            value={sheetCols}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (n > 0) setSheetCols(n);
                            }}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Rows</Label>
                          <Input
                            type="number"
                            min={1}
                            value={sheetRows}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (n > 0) setSheetRows(n);
                            }}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                      {detectedGrid && (
                        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Wand2 className="w-3 h-3" /> Auto-detected {detectedGrid.cols}×
                          {detectedGrid.rows}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Global</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">FPS (default)</Label>
                  <span className="text-[10px] font-mono">{globalFps}</span>
                </div>
                <Slider
                  value={[globalFps]}
                  min={1}
                  max={60}
                  step={1}
                  onValueChange={(v) => setGlobalFps(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">New tags inherit this rate.</p>
              </div>
              <Button
                onClick={() => {
                  if (isPlayingAll) stopPlayback();
                  else {
                    setPlayingTagId(null);
                    setIsPlayingAll(true);
                  }
                }}
                variant="outline"
                className="w-full"
                disabled={frames.length === 0}
              >
                {isPlayingAll ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" /> Stop
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> Play all frames
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {frames.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Export
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button onClick={downloadJson} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download JSON
                </Button>
                <Button onClick={copyJson} variant="outline" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy to Clipboard
                </Button>
                <JsonPreview data={jsonPayload} className="mt-2" />
                <p className="text-[10px] text-muted-foreground pt-1">
                  {tags.length} tag{tags.length === 1 ? "" : "s"} • {frames.length} frame
                  {frames.length === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8 space-y-6">
          <Card className="shadow-lg ring-1 ring-primary/10">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Preview</CardTitle>
                {isProcessing && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setGridTheme((p) => (p === "light" ? "dark" : "light"))}
                >
                  <Palette
                    className={cn(
                      "h-4 w-4",
                      gridTheme === "dark" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                </Button>
              </div>
              <ViewportControls
                onZoomIn={() =>
                  currentFrame && viewport.setZoomIn(currentFrame.width, currentFrame.height)
                }
                onZoomOut={() =>
                  currentFrame && viewport.setZoomOut(currentFrame.width, currentFrame.height)
                }
                onReset={() =>
                  currentFrame && viewport.fitToView(currentFrame.width, currentFrame.height)
                }
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                ref={previewContainerRef}
                className={cn(
                  "aspect-video min-h-96 rounded-lg border overflow-hidden relative cursor-move touch-none",
                  gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                )}
              >
                {currentFrame ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: currentFrame.width,
                        height: currentFrame.height,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <canvas
                        ref={canvasRef}
                        className="block"
                        style={{
                          width: currentFrame.width,
                          height: currentFrame.height,
                          imageRendering: "pixelated",
                        }}
                      />
                    </div>
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      #{currentIndex}
                      {playingTagId && ` · ${tags.find((t) => t.id === playingTagId)?.name}`}
                      {isPlayingAll && " · all"}
                    </div>
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <TagsIcon className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sheet to add tags</p>
                  </div>
                )}
              </div>

              {frames.length > 1 && (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      stopPlayback();
                      setCurrentIndex((i) => (i - 1 + frames.length) % frames.length);
                    }}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Slider
                    className="flex-1"
                    value={[currentIndex]}
                    min={0}
                    max={frames.length - 1}
                    step={1}
                    onValueChange={(v) => {
                      stopPlayback();
                      setCurrentIndex(Array.isArray(v) ? v[0] : v);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      stopPlayback();
                      setCurrentIndex((i) => (i + 1) % frames.length);
                    }}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {frames.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Timer className="w-4 h-4" /> Timing
                </CardTitle>
                <CardDescription className="text-xs">
                  Hold times are stored per frame for the whole sheet. A frame left on{" "}
                  <span className="italic">auto</span> inherits the FPS of whichever tag plays it —
                  right now {timingTag ? `“${timingTag.name}”` : "the global default"} at{" "}
                  {timingFps} FPS ({timingBaseMs}ms). Cell width shows the rhythm.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-1 overflow-x-auto pb-1">
                  {frames.map((f, i) => {
                    const explicit = frameDurations[i] ?? null;
                    const ms = resolveFrameDurationMs(frameDurations, i, timingFps);
                    const width = Math.round(
                      Math.max(26, Math.min(88, (26 * ms) / Math.max(1, timingBaseMs))),
                    );
                    return (
                      <button
                        type="button"
                        key={f.index}
                        style={{ width }}
                        title={
                          explicit === null
                            ? `Frame ${i} — auto (${ms}ms at ${timingFps} FPS)`
                            : `Frame ${i} — held ${explicit}ms`
                        }
                        onClick={() => {
                          stopPlayback();
                          setCurrentIndex(i);
                        }}
                        className={cn(
                          "shrink-0 h-12 rounded-sm border flex flex-col items-center justify-center gap-1 px-0.5 transition-colors",
                          i === currentIndex
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <span className="text-[10px] font-mono leading-none">{i}</span>
                        <span
                          className={cn(
                            "text-[9px] font-mono leading-none",
                            explicit === null && "italic opacity-60",
                          )}
                        >
                          {explicit === null ? "auto" : explicit}
                        </span>
                        <span
                          className={cn(
                            "block h-0.5 w-4/5 rounded-full",
                            explicit === null ? "bg-transparent" : "bg-primary",
                          )}
                        />
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-xs">Frame #{currentIndex}</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={currentExplicitMs ?? ""}
                    placeholder={`${currentDurationMs} (auto)`}
                    // Playback moves currentIndex every tick, which would send
                    // keystrokes to whichever frame is on screen and reset the
                    // field mid-typing. Pin the frame the moment it is focused.
                    onFocus={stopPlayback}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === "") {
                        setFrameDuration(currentIndex, null);
                        return;
                      }
                      const n = Number(raw);
                      if (Number.isFinite(n) && n > 0) {
                        setFrameDuration(currentIndex, Math.min(60000, n));
                      }
                    }}
                    className="h-8 text-xs w-24"
                  />
                  <span className="text-[10px] text-muted-foreground">ms</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    disabled={currentExplicitMs === null}
                    onClick={() => setFrameDuration(currentIndex, null)}
                  >
                    Auto
                  </Button>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[10px]"
                    title={`Hold every frame for ${currentDurationMs}ms`}
                    onClick={() => setRangeDuration(0, frames.length - 1, currentDurationMs)}
                  >
                    Apply to all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    disabled={heldCount === 0}
                    onClick={() => setRangeDuration(0, frames.length - 1, null)}
                  >
                    Clear all
                  </Button>
                </div>

                <p className="text-[10px] text-muted-foreground">
                  {heldCount === 0
                    ? "No explicit holds — the export omits frameDurations entirely."
                    : `${heldCount} of ${frames.length} frame${
                        frames.length === 1 ? "" : "s"
                      } hold an explicit duration.`}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Tags</CardTitle>
                <CardDescription className="text-xs">
                  Each tag is a named [from, to] range. Set from/to with the “@” buttons using the
                  current frame.
                </CardDescription>
              </div>
              <Button onClick={addTag} disabled={frames.length === 0} size="sm">
                <Plus className="w-4 h-4 mr-1" /> Add tag
              </Button>
            </CardHeader>
            <CardContent>
              {tags.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  No tags yet. Click &ldquo;Add tag&rdquo; to create one at frame {currentIndex}.
                </div>
              ) : (
                <div className="space-y-3">
                  {tags.map((t) => (
                    <TagRow
                      key={t.id}
                      tag={t}
                      frameCount={frames.length}
                      currentIndex={currentIndex}
                      durations={frameDurations}
                      isPlaying={playingTagId === t.id}
                      onChange={(patch) => updateTag(t.id, patch)}
                      onSetRangeDuration={(ms) => setRangeDuration(t.from, t.to, ms)}
                      onDelete={() => deleteTag(t.id)}
                      onSetFromCurrent={(which) => setRangeFromCurrent(t.id, which)}
                      onTogglePlay={() => {
                        if (playingTagId === t.id) stopPlayback();
                        else {
                          setIsPlayingAll(false);
                          setPlayingTagId(t.id);
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground px-4 py-2 rounded shadow-lg text-sm">
          {error}
        </div>
      )}
    </main>
  );
}

// -----------------------------------------------------------------
// Single tag row
// -----------------------------------------------------------------
function TagRow({
  tag,
  frameCount,
  currentIndex,
  durations,
  isPlaying,
  onChange,
  onSetRangeDuration,
  onDelete,
  onSetFromCurrent,
  onTogglePlay,
}: {
  tag: Tag;
  frameCount: number;
  currentIndex: number;
  durations: FrameDurations;
  isPlaying: boolean;
  onChange: (patch: Partial<Tag>) => void;
  onSetRangeDuration: (ms: number | null) => void;
  onDelete: () => void;
  onSetFromCurrent: (which: "from" | "to") => void;
  onTogglePlay: () => void;
}) {
  // Blank means "whatever this tag's FPS implies", so the Apply button always
  // has something sensible to write even before the user types a number.
  const [holdDraft, setHoldDraft] = useState("");
  const fpsMs = fpsToDurationMs(tag.fps);
  const draftMs = holdDraft.trim() === "" ? fpsMs : Number(holdDraft);
  const canApply = Number.isFinite(draftMs) && draftMs > 0;

  const lo = Math.max(0, Math.min(tag.from, tag.to));
  const hi = Math.min(Math.max(0, frameCount - 1), Math.max(tag.from, tag.to));
  const totalMs = useMemo(
    () => totalDurationMs(tagSequence(tag, frameCount), durations, tag.fps),
    [tag, frameCount, durations],
  );
  let heldInRange = 0;
  for (let i = lo; i <= hi; i++) if ((durations[i] ?? null) !== null) heldInRange++;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 p-2 rounded-md border",
        isPlaying && "ring-2 ring-primary ring-offset-1",
      )}
    >
      <Input
        value={tag.name}
        onChange={(e) => onChange({ name: e.target.value })}
        className="h-8 text-xs w-28"
        placeholder="name"
      />
      <div className="flex items-center gap-1">
        <Label className="text-[10px] text-muted-foreground">From</Label>
        <Input
          type="number"
          min={0}
          max={Math.max(0, frameCount - 1)}
          value={tag.from}
          onChange={(e) => {
            const n = Math.max(0, Math.min(frameCount - 1, Number(e.target.value)));
            onChange({ from: n });
          }}
          className="h-8 text-xs w-14"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[10px]"
          title={`Set From = ${currentIndex}`}
          onClick={() => onSetFromCurrent("from")}
        >
          @{currentIndex}
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Label className="text-[10px] text-muted-foreground">To</Label>
        <Input
          type="number"
          min={0}
          max={Math.max(0, frameCount - 1)}
          value={tag.to}
          onChange={(e) => {
            const n = Math.max(0, Math.min(frameCount - 1, Number(e.target.value)));
            onChange({ to: n });
          }}
          className="h-8 text-xs w-14"
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[10px]"
          title={`Set To = ${currentIndex}`}
          onClick={() => onSetFromCurrent("to")}
        >
          @{currentIndex}
        </Button>
      </div>
      <div className="flex items-center gap-1">
        {(["forward", "reverse", "pingpong"] as const).map((d) => (
          <Button
            key={d}
            size="sm"
            variant={tag.direction === d ? "default" : "ghost"}
            className="h-7 text-[10px] px-2"
            onClick={() => onChange({ direction: d })}
          >
            {d === "pingpong" ? "↔" : d === "reverse" ? "←" : "→"}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Label className="text-[10px] text-muted-foreground">FPS</Label>
        <Input
          type="number"
          min={1}
          max={120}
          value={tag.fps}
          onChange={(e) => {
            const n = Math.max(1, Math.min(120, Number(e.target.value)));
            onChange({ fps: n });
          }}
          className="h-8 text-xs w-14"
        />
      </div>
      <div className="flex-1" />
      <Button
        size="sm"
        variant={isPlaying ? "default" : "outline"}
        className="h-8"
        onClick={onTogglePlay}
      >
        {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
        onClick={onDelete}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>

      {/* Hold times for the whole from..to range in one action. */}
      <div className="w-full flex flex-wrap items-center gap-2 pt-2 mt-1 border-t">
        <Label className="text-[10px] text-muted-foreground">Hold</Label>
        <Input
          type="number"
          min={1}
          step={1}
          value={holdDraft}
          placeholder={`${fpsMs}`}
          onChange={(e) => setHoldDraft(e.target.value)}
          className="h-8 text-xs w-16"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[10px]"
          disabled={!canApply || frameCount === 0}
          title={`Hold frames ${lo}–${hi} for ${canApply ? Math.round(draftMs) : fpsMs}ms each`}
          onClick={() => canApply && onSetRangeDuration(Math.round(draftMs))}
        >
          Apply {lo}–{hi}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[10px]"
          disabled={heldInRange === 0}
          title={`Clear explicit holds on frames ${lo}–${hi}`}
          onClick={() => onSetRangeDuration(null)}
        >
          Auto
        </Button>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-muted-foreground">
          {heldInRange > 0 && `${heldInRange} held · `}
          {(totalMs / 1000).toFixed(2)}s
        </span>
      </div>
    </div>
  );
}
