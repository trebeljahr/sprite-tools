"use client";

import * as React from "react";
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
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import { useSharedProjectSource } from "@/lib/project/store";

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

export default function TagsPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("sheet");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<TagFrame[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      if (!t || frames.length === 0) return [];
      const lo = Math.max(0, Math.min(t.from, t.to));
      const hi = Math.min(frames.length - 1, Math.max(t.from, t.to));
      if (t.direction === "reverse") {
        return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
      } else if (t.direction === "pingpong") {
        const fwd = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        const rev = fwd.slice(1, -1).reverse();
        return [...fwd, ...rev];
      }
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    return [];
  }, [isPlayingAll, playingTagId, tags, frames.length]);

  const playbackFps = useMemo(() => {
    if (isPlayingAll) return globalFps;
    const t = tags.find((x) => x.id === playingTagId);
    return t?.fps ?? globalFps;
  }, [isPlayingAll, playingTagId, tags, globalFps]);

  useEffect(() => {
    if (playbackSequence.length === 0) {
      if (playbackRef.current) {
        window.clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
      return;
    }
    // Step through the sequence. Keep currentIndex in sync.
    let step = 0;
    // Start from where the tag begins rather than continuing a stale index
    setCurrentIndex(playbackSequence[0]);
    playbackRef.current = window.setInterval(() => {
      step = (step + 1) % playbackSequence.length;
      setCurrentIndex(playbackSequence[step]);
    }, Math.max(16, Math.round(1000 / Math.max(1, playbackFps))));
    return () => {
      if (playbackRef.current) {
        window.clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
    };
  }, [playbackSequence, playbackFps]);

  const stopPlayback = () => {
    setPlayingTagId(null);
    setIsPlayingAll(false);
  };

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
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      frameCount: frames.length,
      tags: tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        fps: t.fps,
      })),
    };
  }, [frames, tags, sourceFile, sourceMode, sheetCols, sheetRows]);

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
  };

  const copyJson = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <main className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <TagsIcon className="w-8 h-8 text-primary" />
          Animation Tags
        </h1>
        <p className="text-muted-foreground">
          Split a sheet into named clips — idle, run, jump — and export Aseprite-style JSON.
        </p>
      </div>

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
                    <p className="text-sm text-muted-foreground">
                      Upload / drop / paste
                    </p>
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

              {sourceUrl && (
                <>
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/30 border">
                    {(
                      [
                        { id: "single" as const, label: "Single", Icon: ImageIcon },
                        { id: "sheet" as const, label: "Sheet", Icon: Grid3x3 },
                      ]
                    ).map(({ id, label, Icon }) => (
                      <button
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
                <p className="text-[10px] text-muted-foreground">
                  New tags inherit this rate.
                </p>
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
                <p className="text-[10px] text-muted-foreground pt-1">
                  {tags.length} tag{tags.length === 1 ? "" : "s"} • {frames.length}{" "}
                  frame{frames.length === 1 ? "" : "s"}
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
                {isProcessing && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() =>
                    setGridTheme((p) => (p === "light" ? "dark" : "light"))
                  }
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
                      {playingTagId && " · " + tags.find((t) => t.id === playingTagId)?.name}
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

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Tags</CardTitle>
                <CardDescription className="text-xs">
                  Each tag is a named [from, to] range. Set from/to with the “@” buttons using the current frame.
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
                      isPlaying={playingTagId === t.id}
                      onChange={(patch) => updateTag(t.id, patch)}
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
  isPlaying,
  onChange,
  onDelete,
  onSetFromCurrent,
  onTogglePlay,
}: {
  tag: Tag;
  frameCount: number;
  currentIndex: number;
  isPlaying: boolean;
  onChange: (patch: Partial<Tag>) => void;
  onDelete: () => void;
  onSetFromCurrent: (which: "from" | "to") => void;
  onTogglePlay: () => void;
}) {
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
    </div>
  );
}
