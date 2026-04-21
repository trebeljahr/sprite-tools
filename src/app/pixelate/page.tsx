"use client";

import * as React from "react";
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
  hexToRgb,
  pixelate,
  type PixelateOptions,
  type RGB,
} from "@/lib/pixel-art/pixelate";
import { PALETTES, paletteById } from "@/lib/pixel-art/palettes";

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

export default function PixelatePage() {
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [pixelSize, setPixelSize] = useState(4);
  const [colorCount, setColorCount] = useState(16);
  const [dither, setDither] = useState(false);
  const [paletteId, setPaletteId] = useState("none");
  const [alphaThreshold, setAlphaThreshold] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);

  const [rawFrames, setRawFrames] = useState<RawFrame[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
      setSourceFile(file);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setSourceUrl(URL.createObjectURL(file));
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
    [sourceUrl],
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
  // Slice — cached by source+grid, independent of pixel params
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
          const data = await frameToImageData(f);
          out.push({
            index: out.length,
            width: f.width,
            height: f.height,
            cellRow: f.metadata?.cellRow,
            cellCol: f.metadata?.cellCol,
            original: data,
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
  // Derived: pixelated frames (re-runs instantly when params change)
  // -----------------------------------------------------------------
  const palette: RGB[] | undefined = useMemo(() => {
    const preset = paletteById(paletteId);
    if (preset.colors.length === 0) return undefined;
    return preset.colors.map(hexToRgb);
  }, [paletteId]);

  const pixelatedFrames = useMemo(() => {
    if (rawFrames.length === 0) return [];
    const opts: Partial<PixelateOptions> = {
      pixelSize,
      colorCount,
      dither: dither ? "floyd-steinberg" : "none",
      palette,
      alphaThreshold,
    };
    return rawFrames.map((f) => pixelate(f.original, opts));
  }, [rawFrames, pixelSize, colorCount, dither, palette, alphaThreshold]);

  // -----------------------------------------------------------------
  // Canvas rendering — one canvas per frame for preview + thumbs
  // -----------------------------------------------------------------
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawFrame = rawFrames[currentIndex];
  const pixelatedFrame = pixelatedFrames[currentIndex];
  const displayW = rawFrame?.width ?? 0;
  const displayH = rawFrame?.height ?? 0;

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !rawFrame) return;
    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, displayW, displayH);
    if (showOriginal || !pixelatedFrame) {
      ctx.putImageData(rawFrame.original, 0, 0);
    } else {
      // Draw the low-res pixelatedFrame scaled up to source dimensions via
      // a tiny intermediate canvas + drawImage with smoothing off.
      const tmp = document.createElement("canvas");
      tmp.width = pixelatedFrame.width;
      tmp.height = pixelatedFrame.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) return;
      tctx.putImageData(pixelatedFrame, 0, 0);
      ctx.drawImage(tmp, 0, 0, displayW, displayH);
    }
  }, [rawFrame, pixelatedFrame, showOriginal, displayW, displayH]);

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
    if (!pixelatedFrame || !sourceFile) return;
    const blob = await imageDataToBlob(pixelatedFrame);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download =
      sourceMode === "sheet"
        ? `${base}-pixelated-${currentIndex}.png`
        : `${base}-pixelated.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Frame downloaded");
  };

  const downloadStitched = async () => {
    if (pixelatedFrames.length === 0 || !sourceFile) return;
    // Stitch all pixelated frames into a grid that mirrors the source grid.
    const cellW = pixelatedFrames[0].width;
    const cellH = pixelatedFrames[0].height;
    const cols = sourceMode === "sheet" ? effectiveCols : 1;
    const rows = Math.ceil(pixelatedFrames.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cellW * cols;
    canvas.height = cellH * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < pixelatedFrames.length; i++) {
      const raw = rawFrames[i];
      // Prefer the source cell row/col so sparse sheets stay aligned.
      const c = raw.cellCol ?? i % cols;
      const r = raw.cellRow ?? Math.floor(i / cols);
      const tmp = document.createElement("canvas");
      tmp.width = pixelatedFrames[i].width;
      tmp.height = pixelatedFrames[i].height;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(pixelatedFrames[i], 0, 0);
      ctx.drawImage(tmp, c * cellW, r * cellH);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-pixelated-sheet.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Sheet downloaded");
  };

  return (
    <main className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Sparkles className="w-8 h-8 text-primary" />
          Pixelate
        </h1>
        <p className="text-muted-foreground">
          Turn any sprite into pixel art — downsample, quantize, dither, snap to a palette.
        </p>
      </div>

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
              <CardTitle>Pixelate</CardTitle>
              <CardDescription className="text-xs">Live preview.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Pixel size</Label>
                  <span className="text-[10px] font-mono">{pixelSize}×</span>
                </div>
                <Slider
                  value={[pixelSize]}
                  min={1}
                  max={32}
                  step={1}
                  onValueChange={(v) => setPixelSize(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Source pixels merged per output pixel.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Colors</Label>
                  <span className="text-[10px] font-mono">
                    {colorCount === 0 ? "off" : colorCount}
                  </span>
                </div>
                <Slider
                  value={[colorCount]}
                  min={0}
                  max={64}
                  step={1}
                  onValueChange={(v) => setColorCount(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  0 = no quantization. Ignored when a palette is selected.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Palette</Label>
                <Select
                  value={paletteId}
                  onValueChange={(v) => v && setPaletteId(v)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PALETTES.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {paletteId !== "none" && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {paletteById(paletteId).colors.map((c) => (
                      <div
                        key={c}
                        className="w-4 h-4 rounded border border-border/40"
                        style={{ background: c }}
                        title={c}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Dither</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Floyd–Steinberg error diffusion during palette snap.
                  </p>
                </div>
                <Switch checked={dither} onCheckedChange={setDither} />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Alpha cutoff</Label>
                  <span className="text-[10px] font-mono">{alphaThreshold}</span>
                </div>
                <Slider
                  value={[alphaThreshold]}
                  min={0}
                  max={254}
                  step={1}
                  onValueChange={(v) => setAlphaThreshold(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Force alpha to 0 or 255 — kills soft edges.
                </p>
              </div>
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
                {isProcessing && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
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
                  title="Hold to compare"
                >
                  {showOriginal ? (
                    <>
                      <Eye className="w-3 h-3" /> Original
                    </>
                  ) : (
                    <>
                      <EyeOff className="w-3 h-3" /> Pixelated
                    </>
                  )}
                </Button>
              </div>
              <ViewportControls
                onZoomIn={() =>
                  rawFrame && viewport.setZoomIn(rawFrame.width, rawFrame.height)
                }
                onZoomOut={() =>
                  rawFrame && viewport.setZoomOut(rawFrame.width, rawFrame.height)
                }
                onReset={() =>
                  rawFrame && viewport.fitToView(rawFrame.width, rawFrame.height)
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
                        ref={overlayCanvasRef}
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
                            setCurrentIndex(
                              (i) => (i - 1 + rawFrames.length) % rawFrames.length,
                            )
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
                    {pixelatedFrame && (
                      <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                        {pixelatedFrame.width}×{pixelatedFrame.height}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Sparkles className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite to pixelate</p>
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
                    onValueChange={(v) =>
                      setCurrentIndex(Array.isArray(v) ? v[0] : v)
                    }
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
