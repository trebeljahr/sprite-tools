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
  Hexagon,
  ImageIcon,
  Loader2,
  Palette,
  Sparkles,
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  BackgroundRemovalSettings,
  type BackgroundRemovalState,
} from "@/components/background-removal-settings";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import { chromaKey as runChromaKey } from "@/lib/pipeline/transforms";
import type { Frame, Frames, ChromaKeyConfig, BackgroundMode } from "@/lib/pipeline/types";
import {
  DEFAULT_OUTLINE_OPTIONS,
  generateOutline,
  type OutlineResult,
} from "@/lib/collision/outline";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";

interface RawFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  previewUrl: string;
  imageData: ImageData;
}

interface ProcessedFrame extends RawFrame {
  outline: OutlineResult;
}

type SourceMode = "single" | "sheet";

function chromaConfigFrom(br: BackgroundRemovalState): ChromaKeyConfig {
  return {
    mode: br.backgroundMode as BackgroundMode,
    similarity: br.similarity,
    softness: br.softness,
    spill: br.spill,
    choke: br.choke,
  };
}

async function consumeChromaKey(frames: Frames, cfg: ChromaKeyConfig): Promise<Frames> {
  const gen = runChromaKey(frames, cfg);
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}

async function frameToImageData(frame: Frame): Promise<{ imageData: ImageData; url: string }> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, frame.width, frame.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("toBlob failed");
  const url = URL.createObjectURL(blob);
  return { imageData, url };
}

export default function CollisionPage() {
  // --- Source (persisted in IndexedDB, shared across all tool tabs) ---
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  // --- Chroma ---
  const [brState, setBrState] = useState<BackgroundRemovalState>({
    backgroundMode: "transparent-cutout",
    autoCrop: false,
    aspectRatio: "free",
    similarity: 30,
    softness: 10,
    spill: 20,
    choke: 1,
  });

  // --- Outline params ---
  const [alphaThreshold, setAlphaThreshold] = useState<number>(
    DEFAULT_OUTLINE_OPTIONS.alphaThreshold,
  );
  const [simplifyTolerance, setSimplifyTolerance] = useState<number>(
    DEFAULT_OUTLINE_OPTIONS.simplifyTolerance,
  );
  const [useConvexHull, setUseConvexHull] = useState<boolean>(
    DEFAULT_OUTLINE_OPTIONS.convexHull,
  );

  // --- Processed output ---
  // rawFrames: source-derived state (depends on file + grid + chroma).
  // frames: rawFrames decorated with outlines — derived via useMemo so that
  // tweaking outline sliders never re-slices the sheet.
  const [rawFrames, setRawFrames] = useState<RawFrame[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // --- UI chrome ---
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Viewport ---
  const viewport = useViewport();
  const { view, containerRef: previewContainerRef, baseView } = viewport;
  const hasAutoFittedRef = useRef(false);

  // -----------------------------------------------------------------
  // Upload handling
  // -----------------------------------------------------------------

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file.");
      return;
    }
    await setSharedSource(file);
    setCurrentIndex(0);
    hasAutoFittedRef.current = false;

    // Try grid auto-detection
    try {
      const det = await detectSheetGrid(file);
      if (det.confidence > 0 && (det.cols > 1 || det.rows > 1)) {
        setSourceMode("sheet");
        setSheetCols(det.cols);
        setSheetRows(det.rows);
        setDetectedGrid({ cols: det.cols, rows: det.rows });
        toast.success(`Detected ${det.cols}×${det.rows} sprite grid`);
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
  }, [setSharedSource]);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  // Global paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) void handleFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  // -----------------------------------------------------------------
  // Effect 1: slice + chroma-key whenever source/grid/chroma changes.
  //           Produces per-frame ImageData + preview URLs.
  // -----------------------------------------------------------------

  // Cache frames keyed on "slicing" inputs so we don't re-slice on chroma
  // slider drags. Re-sliced only when source/grid changes.
  const slicedFramesRef = useRef<Frames | null>(null);
  const slicedKeyRef = useRef<string>("");

  const effectiveCols = sourceMode === "single" ? 1 : Math.max(1, sheetCols);
  const effectiveRows = sourceMode === "single" ? 1 : Math.max(1, sheetRows);

  useEffect(() => {
    if (!sourceFile) {
      setRawFrames((prev) => {
        for (const f of prev) URL.revokeObjectURL(f.previewUrl);
        return [];
      });
      return;
    }

    let cancelled = false;
    const sliceKey = `${sourceFile.name}|${sourceFile.size}|${effectiveCols}x${effectiveRows}`;

    (async () => {
      setIsProcessing(true);
      setError(null);
      try {
        // --- Slicing (cached) ---
        let sliced = slicedFramesRef.current;
        if (slicedKeyRef.current !== sliceKey || !sliced) {
          sliced = await importFromSpriteSheet(sourceFile, {
            cols: effectiveCols,
            rows: effectiveRows,
          });
          slicedFramesRef.current = sliced;
          slicedKeyRef.current = sliceKey;
        }
        if (cancelled) return;

        // --- Chroma-key (if enabled) ---
        const chromaCfg = chromaConfigFrom(brState);
        const keyed =
          chromaCfg.mode === "chroma-transparent"
            ? await consumeChromaKey(sliced, chromaCfg)
            : sliced;
        if (cancelled) return;

        // --- Extract ImageData + preview URLs ---
        const out: RawFrame[] = [];
        for (const f of keyed.frames) {
          const { imageData, url } = await frameToImageData(f);
          out.push({
            index: out.length,
            width: f.width,
            height: f.height,
            cellRow: f.metadata?.cellRow,
            cellCol: f.metadata?.cellCol,
            previewUrl: url,
            imageData,
          });
        }
        if (cancelled) {
          for (const f of out) URL.revokeObjectURL(f.previewUrl);
          return;
        }

        setRawFrames((prev) => {
          for (const f of prev) URL.revokeObjectURL(f.previewUrl);
          return out;
        });
        setCurrentIndex(0);
        hasAutoFittedRef.current = false;
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          toast.error("Failed to process sheet");
        }
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceFile,
    effectiveCols,
    effectiveRows,
    brState.backgroundMode,
    brState.similarity,
    brState.softness,
    brState.spill,
    brState.choke,
  ]);

  // -----------------------------------------------------------------
  // Derived: decorate raw frames with outlines. Re-computes instantly
  // when outline sliders change — no re-slicing, no re-chroma.
  // -----------------------------------------------------------------
  const frames: ProcessedFrame[] = useMemo(
    () =>
      rawFrames.map((f) => ({
        ...f,
        outline: generateOutline(f.imageData, {
          alphaThreshold,
          simplifyTolerance,
          convexHull: useConvexHull,
        }),
      })),
    [rawFrames, alphaThreshold, simplifyTolerance, useConvexHull],
  );

  // -----------------------------------------------------------------
  // Cleanup preview URLs on unmount
  // -----------------------------------------------------------------
  useEffect(() => {
    return () => {
      for (const f of rawFrames) URL.revokeObjectURL(f.previewUrl);
      // sourceUrl lifecycle is owned by useSharedProjectSource now.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------
  // Auto-fit + wheel wiring
  // -----------------------------------------------------------------
  const currentFrame = frames[currentIndex];

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
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", prevent, { passive: false });
    el.addEventListener("gesturechange", prevent, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", prevent);
      el.removeEventListener("gesturechange", prevent);
    };
  }, [viewport, previewContainerRef]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (frames.length === 0) return;
      if (e.key === "ArrowRight") {
        setCurrentIndex((i) => (i + 1) % frames.length);
      } else if (e.key === "ArrowLeft") {
        setCurrentIndex((i) => (i - 1 + frames.length) % frames.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);

  // -----------------------------------------------------------------
  // Overlay canvas — render sprite + polygon
  // -----------------------------------------------------------------
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !currentFrame) return;

    canvas.width = currentFrame.width;
    canvas.height = currentFrame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(currentFrame.imageData, 0, 0);

    const { polygon } = currentFrame.outline;
    if (polygon.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(polygon[0].x + 0.5, polygon[0].y + 0.5);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x + 0.5, polygon[i].y + 0.5);
    }
    ctx.closePath();

    ctx.fillStyle = "rgba(74, 222, 128, 0.25)";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(22, 163, 74, 0.95)";
    ctx.stroke();

    // Vertex markers
    ctx.fillStyle = "rgba(22, 163, 74, 1)";
    for (const p of polygon) {
      ctx.beginPath();
      ctx.arc(p.x + 0.5, p.y + 0.5, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }, [currentFrame]);

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  // JSON shape mirrors `sprite-tools collision` CLI output so files produced
  // in the browser can be consumed by the same tooling (and merged with jq).
  const jsonPayload = useMemo(() => {
    if (frames.length === 0 || !sourceFile) return null;
    const anyFrame = frames[0];
    return {
      source: sourceFile.name,
      frameWidth: anyFrame.width,
      frameHeight: anyFrame.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      options: {
        alphaThreshold,
        simplifyTolerance,
        convexHull: useConvexHull,
        chroma:
          brState.backgroundMode === "chroma-transparent"
            ? {
                similarity: brState.similarity,
                softness: brState.softness,
                spill: brState.spill,
                choke: brState.choke,
              }
            : null,
      },
      collision: frames.map((f) => ({
        index: f.index,
        cell:
          f.cellRow != null && f.cellCol != null
            ? { row: f.cellRow, col: f.cellCol }
            : { row: Math.floor(f.index / sheetCols), col: f.index % sheetCols },
        pointCount: f.outline.polygon.length,
        bounds: f.outline.bounds,
        polygon: f.outline.polygon.map((p) => [p.x, p.y] as const),
      })),
    };
  }, [
    frames,
    sourceFile,
    sourceMode,
    sheetCols,
    sheetRows,
    alphaThreshold,
    simplifyTolerance,
    useConvexHull,
    brState,
  ]);

  const downloadJson = () => {
    if (!jsonPayload || !sourceFile) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const baseName = sourceFile.name.replace(/\.[^.]+$/, "");
    a.href = url;
    a.download = `${baseName}-collision.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Collision JSON downloaded");
  };

  const copyJson = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
      toast.success("Copied JSON to clipboard");
    } catch {
      toast.error("Clipboard copy failed");
    }
  };

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  const totalPoints = frames.reduce((n, f) => n + f.outline.polygon.length, 0);
  const avgPoints = frames.length > 0 ? totalPoints / frames.length : 0;

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Collision"
        description="Trace tight collision outlines from a sprite or sheet — tune, preview, export JSON."
        icon={Hexagon}
        category="metadata"
        docs="collision"
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column: Source + Settings + Export */}
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Upload a single sprite or a sprite sheet. Grid is auto-detected where possible.
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
                      Upload / drop / paste an image
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
                          <Wand2 className="w-3 h-3" />
                          Auto-detected {detectedGrid.cols}×{detectedGrid.rows}
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
              <CardTitle>Background Removal</CardTitle>
              <CardDescription className="text-xs">
                Enable chroma key if your image has a solid colored background. Pure-alpha sprites can skip this.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BackgroundRemovalSettings
                state={brState}
                setState={setBrState}
                mode="chroma-only"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Outline</CardTitle>
              <CardDescription className="text-xs">
                Tune the polygon — updates live as you drag.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Alpha threshold</Label>
                  <span className="text-[10px] font-mono">{alphaThreshold}</span>
                </div>
                <Slider
                  value={[alphaThreshold]}
                  min={0}
                  max={254}
                  step={1}
                  onValueChange={(v) =>
                    setAlphaThreshold(Array.isArray(v) ? v[0] : v)
                  }
                />
                <p className="text-[10px] text-muted-foreground">
                  Pixels with alpha &gt; this are &ldquo;inside&rdquo;. Raise to ignore soft edges.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Simplification tolerance</Label>
                  <span className="text-[10px] font-mono">
                    {simplifyTolerance.toFixed(2)}px
                  </span>
                </div>
                <Slider
                  value={[simplifyTolerance]}
                  min={0}
                  max={20}
                  step={0.1}
                  onValueChange={(v) =>
                    setSimplifyTolerance(Array.isArray(v) ? v[0] : v)
                  }
                />
                <p className="text-[10px] text-muted-foreground">
                  Higher = fewer vertices. 0 keeps every contour pixel.
                </p>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Convex hull</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Reduce to hull — for Box2D-style convex fixtures.
                  </p>
                </div>
                <Switch
                  checked={useConvexHull}
                  onCheckedChange={setUseConvexHull}
                />
              </div>
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
                <div className="grid grid-cols-3 gap-2 text-[10px] font-mono text-muted-foreground border rounded-md p-2 bg-muted/20">
                  <div>
                    <div className="opacity-60">Frames</div>
                    <div className="text-foreground text-sm font-bold">
                      {frames.length}
                    </div>
                  </div>
                  <div>
                    <div className="opacity-60">Avg pts</div>
                    <div className="text-foreground text-sm font-bold">
                      {avgPoints.toFixed(1)}
                    </div>
                  </div>
                  <div>
                    <div className="opacity-60">Total pts</div>
                    <div className="text-foreground text-sm font-bold">
                      {totalPoints}
                    </div>
                  </div>
                </div>
                <Button onClick={downloadJson} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download JSON
                </Button>
                <Button onClick={copyJson} variant="outline" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy to Clipboard
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Preview */}
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
                  title="Toggle background grid"
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
                  currentFrame &&
                  viewport.setZoomIn(currentFrame.width, currentFrame.height)
                }
                onZoomOut={() =>
                  currentFrame &&
                  viewport.setZoomOut(currentFrame.width, currentFrame.height)
                }
                onReset={() =>
                  currentFrame &&
                  viewport.fitToView(currentFrame.width, currentFrame.height)
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
                onMouseDown={viewport.startPanning}
                onMouseMove={viewport.updatePanning}
                onMouseUp={viewport.stopPanning}
                onMouseLeave={viewport.stopPanning}
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
                        imageRendering: "pixelated",
                      }}
                    >
                      <canvas
                        ref={overlayCanvasRef}
                        className="block"
                        style={{
                          width: currentFrame.width,
                          height: currentFrame.height,
                          imageRendering: "pixelated",
                        }}
                      />
                    </div>
                    {frames.length > 1 && (
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
                        <ChevronLeft
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setCurrentIndex(
                              (i) => (i - 1 + frames.length) % frames.length,
                            )
                          }
                        />
                        {currentIndex + 1} / {frames.length}
                        <ChevronRight
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setCurrentIndex((i) => (i + 1) % frames.length)
                          }
                        />
                      </div>
                    )}
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      {currentFrame.outline.polygon.length} pts
                      {currentFrame.outline.rawContourLength > 0 && (
                        <span className="opacity-60">
                          {" "}
                          / {currentFrame.outline.rawContourLength} raw
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Sparkles className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite to begin</p>
                  </div>
                )}
              </div>

              {frames.length > 1 && (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setCurrentIndex(
                        (i) => (i - 1 + frames.length) % frames.length,
                      )
                    }
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Slider
                    className="flex-1"
                    value={[currentIndex]}
                    min={0}
                    max={frames.length - 1}
                    step={1}
                    onValueChange={(v) =>
                      setCurrentIndex(Array.isArray(v) ? v[0] : v)
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setCurrentIndex((i) => (i + 1) % frames.length)
                    }
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {frames.length > 1 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Frames</CardTitle>
                <CardDescription className="text-xs">
                  {frames.length} sprite{frames.length === 1 ? "" : "s"} — click to preview.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-96 overflow-y-auto p-1">
                  {frames.map((f, i) => (
                    <FrameThumb
                      key={f.index}
                      frame={f}
                      isActive={i === currentIndex}
                      gridTheme={gridTheme}
                      onClick={() => setCurrentIndex(i)}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
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
// Frame thumbnail with polygon overlay
// -----------------------------------------------------------------

const FrameThumb = React.memo(function FrameThumbInner({
  frame,
  isActive,
  gridTheme,
  onClick,
}: {
  frame: ProcessedFrame;
  isActive: boolean;
  gridTheme: "light" | "dark";
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(frame.imageData, 0, 0);
    const { polygon } = frame.outline;
    if (polygon.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(polygon[0].x + 0.5, polygon[0].y + 0.5);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x + 0.5, polygon[i].y + 0.5);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(22, 163, 74, 1)";
    ctx.lineWidth = Math.max(1, Math.min(frame.width, frame.height) / 48);
    ctx.stroke();
    ctx.restore();
  }, [frame]);

  return (
    <button
      onClick={onClick}
      className={cn(
        "aspect-square border rounded overflow-hidden relative transition-all",
        gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
        isActive ? "ring-2 ring-primary ring-offset-1" : "opacity-70 hover:opacity-100",
      )}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full object-contain"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="absolute bottom-0.5 right-0.5 bg-black/60 text-white text-[9px] px-1 rounded font-mono leading-none py-0.5">
        {frame.outline.polygon.length}
      </div>
    </button>
  );
});
