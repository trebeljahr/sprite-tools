"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
  PenTool,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import {
  applyOutlineFx,
  type Connectivity,
  DEFAULT_OUTLINE_FX_OPTIONS,
  DEFAULT_SHADOW_OPTIONS,
  type OutlineFxConfig,
  type OutlineStyle,
  type OverflowMode,
  requiredMargin,
} from "@/lib/outline/outline-fx";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { SampleSprites } from "@/components/sample-sprites";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";

interface RawFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  original: ImageData;
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

function imageDataToBlob(data: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.putImageData(data, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/** applyOutlineFx returns a plain {width, height, data} — wrap it for canvas use.
 *  Copied rather than adopted: the core's buffer is typed ArrayBufferLike, which
 *  the ImageData constructor overloads reject. */
function toImageData(res: { width: number; height: number; data: Uint8ClampedArray }): ImageData {
  // A degenerate (0×0) source yields an empty buffer that ImageData rejects.
  if (res.width <= 0 || res.height <= 0) return new ImageData(1, 1);
  const out = new ImageData(res.width, res.height);
  out.data.set(res.data);
  return out;
}

export default function OutlinePage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  // Outline — alphaThreshold is shared with the shadow (the CLI exposes one flag too).
  const [outlineEnabled, setOutlineEnabled] = useState(true);
  const [outlineStyle, setOutlineStyle] = useState<OutlineStyle>(DEFAULT_OUTLINE_FX_OPTIONS.style);
  const [outlineWidth, setOutlineWidth] = useState(DEFAULT_OUTLINE_FX_OPTIONS.width);
  const [outlineColor, setOutlineColor] = useState(DEFAULT_OUTLINE_FX_OPTIONS.color);
  const [outlineOpacity, setOutlineOpacity] = useState(
    Math.round(DEFAULT_OUTLINE_FX_OPTIONS.opacity * 100),
  );
  const [connectivity, setConnectivity] = useState<Connectivity>(
    DEFAULT_OUTLINE_FX_OPTIONS.connectivity,
  );
  const [alphaThreshold, setAlphaThreshold] = useState(DEFAULT_OUTLINE_FX_OPTIONS.alphaThreshold);

  // Drop shadow
  const [shadowEnabled, setShadowEnabled] = useState(false);
  const [shadowOffsetX, setShadowOffsetX] = useState(DEFAULT_SHADOW_OPTIONS.offsetX);
  const [shadowOffsetY, setShadowOffsetY] = useState(DEFAULT_SHADOW_OPTIONS.offsetY);
  const [shadowColor, setShadowColor] = useState(DEFAULT_SHADOW_OPTIONS.color);
  const [shadowOpacity, setShadowOpacity] = useState(
    Math.round(DEFAULT_SHADOW_OPTIONS.opacity * 100),
  );
  const [shadowBlur, setShadowBlur] = useState(DEFAULT_SHADOW_OPTIONS.blur);

  const [overflow, setOverflow] = useState<OverflowMode>("expand");
  const [showOriginal, setShowOriginal] = useState(false);

  const [rawFrames, setRawFrames] = useState<RawFrame[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasDownloaded, setHasDownloaded] = useState(false);

  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewport = useViewport();
  const { view, containerRef: previewContainerRef, baseView } = viewport;
  const hasAutoFittedRef = useRef(false);

  const effectiveCols = sourceMode === "single" ? 1 : Math.max(1, sheetCols);
  const effectiveRows = sourceMode === "single" ? 1 : Math.max(1, sheetRows);

  // -----------------------------------------------------------------
  // Upload
  // -----------------------------------------------------------------
  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Please upload an image.");
        return;
      }
      await setSharedSource(file);
      setCurrentIndex(0);
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
  // Slice — cached by source+grid, independent of the effect params
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!sourceFile) {
      setRawFrames([]);
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
        const out: RawFrame[] = [];
        for (const f of sliced.frames) {
          out.push({
            index: out.length,
            width: f.width,
            height: f.height,
            cellRow: f.metadata?.cellRow,
            cellCol: f.metadata?.cellCol,
            original: await frameToImageData(f),
          });
        }
        if (cancelled) return;
        setRawFrames(out);
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
  // Derived: the effect (synchronous, no worker — one BFS per frame)
  // -----------------------------------------------------------------
  const config = useMemo<OutlineFxConfig>(
    () => ({
      outline: outlineEnabled
        ? {
            style: outlineStyle,
            width: outlineWidth,
            color: outlineColor,
            opacity: outlineOpacity / 100,
            connectivity,
            alphaThreshold,
          }
        : null,
      shadow: shadowEnabled
        ? {
            offsetX: shadowOffsetX,
            offsetY: shadowOffsetY,
            color: shadowColor,
            opacity: shadowOpacity / 100,
            blur: shadowBlur,
            alphaThreshold,
          }
        : null,
      overflow,
    }),
    [
      outlineEnabled,
      outlineStyle,
      outlineWidth,
      outlineColor,
      outlineOpacity,
      connectivity,
      alphaThreshold,
      shadowEnabled,
      shadowOffsetX,
      shadowOffsetY,
      shadowColor,
      shadowOpacity,
      shadowBlur,
      overflow,
    ],
  );

  // One margin for every frame, so a sheet keeps uniform cells.
  const margin = useMemo(() => requiredMargin(config), [config]);

  const results = useMemo(() => {
    if (rawFrames.length === 0) return [];
    return rawFrames.map((f) => toImageData(applyOutlineFx(f.original, { ...config, margin })));
  }, [rawFrames, config, margin]);

  // -----------------------------------------------------------------
  // Canvas rendering
  // -----------------------------------------------------------------
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawFrame = rawFrames[currentIndex];
  const result = results[currentIndex];
  const displayW = result?.width ?? rawFrame?.width ?? 0;
  const displayH = result?.height ?? rawFrame?.height ?? 0;

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !rawFrame || displayW === 0 || displayH === 0) return;
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, displayW, displayH);
    if (showOriginal || !result) {
      // Park the original where the sprite sits in the expanded canvas so
      // toggling compare doesn't make the art jump.
      const dx = overflow === "clip" ? 0 : margin.left;
      const dy = overflow === "clip" ? 0 : margin.top;
      ctx.putImageData(rawFrame.original, dx, dy);
    } else {
      ctx.putImageData(result, 0, 0);
    }
  }, [rawFrame, result, showOriginal, displayW, displayH, margin, overflow]);

  // -----------------------------------------------------------------
  // Viewport wiring
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!rawFrame || hasAutoFittedRef.current) return;
    if (!previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(rawFrame.width, rawFrame.height);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [rawFrame, previewContainerRef, viewport]);

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
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", prevent);
    };
  }, [viewport, previewContainerRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rawFrames.length === 0) return;
      if (e.key === "ArrowRight") setCurrentIndex((i) => (i + 1) % rawFrames.length);
      else if (e.key === "ArrowLeft")
        setCurrentIndex((i) => (i - 1 + rawFrames.length) % rawFrames.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rawFrames.length]);

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  const downloadCurrent = async () => {
    if (!result || !sourceFile) return;
    const blob = await imageDataToBlob(result);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download =
      sourceMode === "sheet" ? `${base}-outline-${currentIndex}.png` : `${base}-outline.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Frame downloaded");
    setHasDownloaded(true);
  };

  const downloadStitched = async () => {
    if (results.length === 0 || !sourceFile) return;
    // Every frame shares one margin, so every cell is the same size.
    const cellW = results[0].width;
    const cellH = results[0].height;
    const cols = sourceMode === "sheet" ? effectiveCols : 1;
    // Size from the grid, not the surviving frame count: importing a sheet drops
    // empty cells, so results.length can be short of cols*rows. Deriving rows
    // from it would place the last frames past the bottom edge and lose them.
    const rows = sourceMode === "sheet" ? effectiveRows : Math.ceil(results.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cellW * cols;
    canvas.height = cellH * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < results.length; i++) {
      const raw = rawFrames[i];
      // Prefer the source cell row/col so sparse sheets stay aligned.
      const c = raw.cellCol ?? i % cols;
      const r = raw.cellRow ?? Math.floor(i / cols);
      ctx.putImageData(results[i], c * cellW, r * cellH);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-outline-sheet.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Sheet downloaded");
    setHasDownloaded(true);
  };

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        label: "Upload a sprite",
        hint: "Drop an image or click a sample below it.",
        done: !!sourceUrl,
      },
      {
        label: "Dial in outline & shadow",
        hint: "Width, colour and connectivity — the preview updates live.",
        done: rawFrames.length > 0,
      },
      {
        label: "Download PNG",
        hint: "Save the current frame or the stitched sheet.",
        done: hasDownloaded,
      },
    ],
    [sourceUrl, rawFrames.length, hasDownloaded],
  );
  const tutorial = useTutorial({ id: "outline", steps: tutorialSteps });

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Outline & Shadow"
        description="Add a pixel-exact outer or inner outline and a drop shadow — one alpha pass, every hole and island covered."
        icon={PenTool}
        category="transform"
        docs="outline"
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
                Single sprite or sheet. Grid auto-detected.
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
            <CardHeader className="pb-3 flex flex-row items-start justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle>Outline</CardTitle>
                <CardDescription className="text-xs">
                  A band traced at exact pixel distance from the silhouette.
                </CardDescription>
              </div>
              <Switch checked={outlineEnabled} onCheckedChange={setOutlineEnabled} />
            </CardHeader>
            <CardContent className="space-y-5">
              <div
                className={cn(
                  "space-y-5 transition-opacity",
                  !outlineEnabled && "opacity-40 pointer-events-none",
                )}
              >
                <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/30 border">
                  {(
                    [
                      { id: "outer", label: "Outer" },
                      { id: "inner", label: "Inner" },
                    ] as { id: OutlineStyle; label: string }[]
                  ).map(({ id, label }) => (
                    <button
                      type="button"
                      key={id}
                      onClick={() => setOutlineStyle(id)}
                      className={cn(
                        "py-1.5 text-xs font-medium rounded-md transition-colors",
                        outlineStyle === id
                          ? "bg-background shadow-sm text-primary"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground -mt-3">
                  Outer grows past the sprite; inner eats into it and never changes the canvas.
                </p>

                <div className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label className="text-xs">Width</Label>
                    <span className="text-[10px] font-mono">{outlineWidth}px</span>
                  </div>
                  <Slider
                    value={[outlineWidth]}
                    min={0}
                    max={16}
                    step={1}
                    onValueChange={(v) => setOutlineWidth(Array.isArray(v) ? v[0] : v)}
                  />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">Colour</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {outlineColor}
                    </span>
                    <input
                      type="color"
                      aria-label="Outline colour"
                      value={outlineColor}
                      onChange={(e) => setOutlineColor(e.target.value)}
                      className="h-7 w-10 rounded border border-border/60 bg-transparent cursor-pointer"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label className="text-xs">Opacity</Label>
                    <span className="text-[10px] font-mono">{outlineOpacity}%</span>
                  </div>
                  <Slider
                    value={[outlineOpacity]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(v) => setOutlineOpacity(Array.isArray(v) ? v[0] : v)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Connectivity</Label>
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted/30 border">
                    {([4, 8] as Connectivity[]).map((c) => (
                      <button
                        type="button"
                        key={c}
                        onClick={() => setConnectivity(c)}
                        className={cn(
                          "py-1.5 text-xs font-medium rounded-md transition-colors",
                          connectivity === c
                            ? "bg-background shadow-sm text-primary"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {c}-way
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    4 mitres the corners, 8 squares them off and thickens diagonals.
                  </p>
                </div>
              </div>

              {/* Outside the disabled gate: the shadow silhouette uses it too. */}
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Alpha threshold</Label>
                  <span className="text-[10px] font-mono">{alphaThreshold}</span>
                </div>
                <Slider
                  value={[alphaThreshold]}
                  min={0}
                  max={255}
                  step={1}
                  onValueChange={(v) => setAlphaThreshold(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  A pixel counts as sprite above this alpha. Raise it to pull the band inward past
                  soft edges. Shared with the shadow.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-start justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle>Drop shadow</CardTitle>
                <CardDescription className="text-xs">
                  The opaque footprint, offset, blurred and tinted underneath.
                </CardDescription>
              </div>
              <Switch checked={shadowEnabled} onCheckedChange={setShadowEnabled} />
            </CardHeader>
            <CardContent
              className={cn(
                "space-y-5 transition-opacity",
                !shadowEnabled && "opacity-40 pointer-events-none",
              )}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Offset X</Label>
                  <Input
                    type="number"
                    value={shadowOffsetX}
                    min={-256}
                    max={256}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setShadowOffsetX(Math.round(n));
                    }}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Offset Y</Label>
                  <Input
                    type="number"
                    value={shadowOffsetY}
                    min={-256}
                    max={256}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setShadowOffsetY(Math.round(n));
                    }}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs">Colour</Label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-muted-foreground">{shadowColor}</span>
                  <input
                    type="color"
                    aria-label="Shadow colour"
                    value={shadowColor}
                    onChange={(e) => setShadowColor(e.target.value)}
                    className="h-7 w-10 rounded border border-border/60 bg-transparent cursor-pointer"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Opacity</Label>
                  <span className="text-[10px] font-mono">{shadowOpacity}%</span>
                </div>
                <Slider
                  value={[shadowOpacity]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={(v) => setShadowOpacity(Array.isArray(v) ? v[0] : v)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Blur</Label>
                  <span className="text-[10px] font-mono">{shadowBlur}px</span>
                </div>
                <Slider
                  value={[shadowBlur]}
                  min={0}
                  max={32}
                  step={1}
                  onValueChange={(v) => setShadowBlur(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  0 = hard edge. Three box passes approximate a gaussian.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Canvas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Overflow</Label>
                <Select value={overflow} onValueChange={(v) => v && setOverflow(v as OverflowMode)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expand" className="text-xs">
                      Expand — pad so nothing is cropped
                    </SelectItem>
                    <SelectItem value="clip" className="text-xs">
                      Clip — keep the original cell size
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">
                {overflow === "expand"
                  ? `margin ${margin.left}/${margin.top}/${margin.right}/${margin.bottom}`
                  : "margin 0 — effect runs off the edge"}
              </p>
            </CardContent>
          </Card>

          {rawFrames.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Export
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button onClick={downloadCurrent} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download current frame
                </Button>
                {rawFrames.length > 1 && (
                  <Button onClick={downloadStitched} variant="outline" className="w-full">
                    <Grid3x3 className="w-4 h-4 mr-2" /> Download full sheet
                  </Button>
                )}
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
                  title="Toggle background grid"
                >
                  <Palette
                    className={cn(
                      "h-4 w-4",
                      gridTheme === "dark" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                </Button>
                <Button
                  size="sm"
                  variant={showOriginal ? "default" : "outline"}
                  className="h-7 text-xs gap-1"
                  onClick={() => setShowOriginal((p) => !p)}
                  title="Compare against the source"
                >
                  {showOriginal ? (
                    <>
                      <Eye className="w-3 h-3" /> Original
                    </>
                  ) : (
                    <>
                      <EyeOff className="w-3 h-3" /> Result
                    </>
                  )}
                </Button>
              </div>
              <ViewportControls
                onZoomIn={() => rawFrame && viewport.setZoomIn(rawFrame.width, rawFrame.height)}
                onZoomOut={() => rawFrame && viewport.setZoomOut(rawFrame.width, rawFrame.height)}
                onReset={() => rawFrame && viewport.fitToView(rawFrame.width, rawFrame.height)}
              />
            </CardHeader>
            <CardContent className="space-y-3">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
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
                {rawFrame ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: displayW,
                        height: displayH,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <canvas
                        ref={previewCanvasRef}
                        className="block"
                        style={{
                          width: displayW,
                          height: displayH,
                          imageRendering: "pixelated",
                        }}
                      />
                    </div>
                    {rawFrames.length > 1 && (
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
                        <ChevronLeft
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setCurrentIndex((i) => (i - 1 + rawFrames.length) % rawFrames.length)
                          }
                        />
                        {currentIndex + 1} / {rawFrames.length}
                        <ChevronRight
                          className="w-3 h-3 cursor-pointer"
                          onClick={() => setCurrentIndex((i) => (i + 1) % rawFrames.length)}
                        />
                      </div>
                    )}
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                    {result && (
                      <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                        {result.width}×{result.height}
                        {rawFrame.width !== result.width || rawFrame.height !== result.height
                          ? ` (was ${rawFrame.width}×${rawFrame.height})`
                          : ""}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <PenTool className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite to outline</p>
                  </div>
                )}
              </div>

              {rawFrames.length > 1 && (
                <div className="flex items-center gap-3">
                  <Slider
                    className="flex-1"
                    value={[currentIndex]}
                    min={0}
                    max={rawFrames.length - 1}
                    step={1}
                    onValueChange={(v) => setCurrentIndex(Array.isArray(v) ? v[0] : v)}
                  />
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
