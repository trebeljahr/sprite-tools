"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Droplet,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette as PaletteIcon,
  RotateCcw,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import { applyPaletteSwap, extractPalette, hexToRgb, rgbToHex } from "@/lib/palette/extract";
import type { RGB } from "@/lib/pixel-art/pixelate";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";

interface SourceFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  imageData: ImageData;
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

export default function PalettePage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<SourceFrame[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [colorCount, setColorCount] = useState(8);
  const [palette, setPalette] = useState<RGB[]>([]);
  // swapHex[i] = hex string the user wants palette[i] to become.
  const [swapHex, setSwapHex] = useState<string[]>([]);

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

  // Slice
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
        const out: SourceFrame[] = [];
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
  // Extract palette: union of pixels across ALL frames so a shared palette
  // applies consistently to every frame of a sheet.
  // -----------------------------------------------------------------
  useEffect(() => {
    if (frames.length === 0) {
      setPalette([]);
      setSwapHex([]);
      return;
    }
    // Concat all frames' ImageData into one big ImageData for extraction.
    let total = 0;
    for (const f of frames) total += f.width * f.height;
    const merged = new ImageData(total, 1);
    let off = 0;
    for (const f of frames) {
      const n = f.width * f.height * 4;
      merged.data.set(f.imageData.data, off);
      off += n;
    }
    const pal = extractPalette(merged, colorCount);
    setPalette(pal);
    setSwapHex(pal.map(rgbToHex));
  }, [frames, colorCount]);

  // Derived: recolored frame (applies to current frame for preview).
  const swappedCurrent = useMemo<ImageData | null>(() => {
    const f = frames[currentIndex];
    if (!f || palette.length === 0) return null;
    const swaps = palette
      .map((p, i) => ({ from: p, to: hexToRgb(swapHex[i] ?? rgbToHex(p)) }))
      .filter((s) => s.from.r !== s.to.r || s.from.g !== s.to.g || s.from.b !== s.to.b);
    if (swaps.length === 0) return null;
    return applyPaletteSwap(f.imageData, palette, swaps);
  }, [frames, currentIndex, palette, swapHex]);

  // Canvas render
  const current = frames[currentIndex];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(swappedCurrent ?? current.imageData, 0, 0);
  }, [current, swappedCurrent]);

  // Viewport
  useEffect(() => {
    if (!current || hasAutoFittedRef.current) return;
    if (!previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(current.width, current.height);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [current, previewContainerRef, viewport]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (frames.length === 0) return;
      if (e.key === "ArrowRight") setCurrentIndex((i) => (i + 1) % frames.length);
      else if (e.key === "ArrowLeft")
        setCurrentIndex((i) => (i - 1 + frames.length) % frames.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);

  // -----------------------------------------------------------------
  // Swap handlers
  // -----------------------------------------------------------------
  const setSwap = (i: number, hex: string) => {
    setSwapHex((prev) => {
      const next = [...prev];
      next[i] = hex;
      return next;
    });
  };

  const resetSwaps = () => {
    setSwapHex(palette.map(rgbToHex));
  };

  const shiftHue = (delta: number) => {
    setSwapHex((prev) => prev.map((hex) => shiftHueOfHex(hex, delta)));
  };

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  // Same shape as `sprite-tools palette` CLI output. Built via useMemo so the
  // JSON preview panel can render it live without duplicating assembly.
  const jsonPayload = useMemo(() => {
    if (!sourceFile || palette.length === 0 || frames.length === 0) return null;
    const f0 = frames[0];
    const swaps = palette
      .map((p, i) => ({
        from: rgbToHex(p),
        to: swapHex[i] ?? rgbToHex(p),
      }))
      .filter((s) => s.from.toLowerCase() !== s.to.toLowerCase());
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      options: { colors: colorCount },
      palette: palette.map(rgbToHex),
      swaps,
    };
  }, [sourceFile, palette, swapHex, frames, sheetCols, sheetRows, sourceMode, colorCount]);

  const exportPaletteJson = () => {
    if (!jsonPayload || !sourceFile) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-palette.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Palette JSON downloaded");
  };

  const downloadCurrent = async () => {
    const f = frames[currentIndex];
    if (!f || !sourceFile) return;
    const out = swappedCurrent ?? f.imageData;
    const blob = await imageDataToBlob(out);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download =
      sourceMode === "sheet" ? `${base}-recolor-${currentIndex}.png` : `${base}-recolor.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Recolored frame downloaded");
  };

  const downloadStitched = async () => {
    if (frames.length === 0 || !sourceFile || palette.length === 0) return;
    const cellW = frames[0].width;
    const cellH = frames[0].height;
    const cols = sourceMode === "sheet" ? effectiveCols : 1;
    const rows = Math.ceil(frames.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cellW * cols;
    canvas.height = cellH * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const swaps = palette
      .map((p, i) => ({ from: p, to: hexToRgb(swapHex[i] ?? rgbToHex(p)) }))
      .filter((s) => s.from.r !== s.to.r || s.from.g !== s.to.g || s.from.b !== s.to.b);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const c = f.cellCol ?? i % cols;
      const r = f.cellRow ?? Math.floor(i / cols);
      const out = swaps.length > 0 ? applyPaletteSwap(f.imageData, palette, swaps) : f.imageData;
      const tmp = document.createElement("canvas");
      tmp.width = cellW;
      tmp.height = cellH;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(out, 0, 0);
      ctx.drawImage(tmp, c * cellW, r * cellH);
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-recolor-sheet.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Recolored sheet downloaded");
  };

  const copyPalette = async () => {
    if (palette.length === 0) return;
    try {
      await navigator.clipboard.writeText(palette.map(rgbToHex).join("\n"));
      toast.success("Palette copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Palette"
        description="Extract the dominant colors — then swap any of them to recolor the whole sprite."
        icon={PaletteIcon}
        category="transform"
        docs="palette"
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
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
              <CardTitle>Palette</CardTitle>
              <CardDescription className="text-xs">
                Click a swatch to pick a replacement color.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Colors</Label>
                  <span className="text-[10px] font-mono">{colorCount}</span>
                </div>
                <Slider
                  value={[colorCount]}
                  min={2}
                  max={32}
                  step={1}
                  onValueChange={(v) => setColorCount(Array.isArray(v) ? v[0] : v)}
                />
              </div>

              {palette.length > 0 && (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    {palette.map((c, i) => (
                      <PaletteSwatch
                        key={`${rgbToHex(c)}-${i}`}
                        sourceHex={rgbToHex(c)}
                        currentHex={swapHex[i] ?? rgbToHex(c)}
                        onChange={(hex) => setSwap(i, hex)}
                      />
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1 pt-2 border-t border-dashed">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(-30)}
                      className="h-8 text-[10px]"
                    >
                      Hue −30°
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(180)}
                      className="h-8 text-[10px]"
                    >
                      Invert hue
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(30)}
                      className="h-8 text-[10px]"
                    >
                      Hue +30°
                    </Button>
                  </div>
                  <Button size="sm" variant="outline" className="w-full" onClick={resetSwaps}>
                    <RotateCcw className="w-3.5 h-3.5 mr-2" /> Reset swaps
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {frames.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" /> Export
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button onClick={downloadCurrent} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Recolored frame (PNG)
                </Button>
                {frames.length > 1 && (
                  <Button onClick={downloadStitched} variant="outline" className="w-full">
                    <Grid3x3 className="w-4 h-4 mr-2" /> Recolored sheet (PNG)
                  </Button>
                )}
                <Button onClick={exportPaletteJson} variant="outline" className="w-full">
                  <Droplet className="w-4 h-4 mr-2" /> Palette JSON
                </Button>
                <Button onClick={copyPalette} variant="ghost" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy hex list
                </Button>
                <JsonPreview data={jsonPayload} className="mt-2" />
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
                  <PaletteIcon
                    className={cn(
                      "h-4 w-4",
                      gridTheme === "dark" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                </Button>
              </div>
              <ViewportControls
                onZoomIn={() => current && viewport.setZoomIn(current.width, current.height)}
                onZoomOut={() => current && viewport.setZoomOut(current.width, current.height)}
                onReset={() => current && viewport.fitToView(current.width, current.height)}
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
                {current ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: current.width,
                        height: current.height,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <canvas
                        ref={canvasRef}
                        className="block"
                        style={{
                          width: current.width,
                          height: current.height,
                          imageRendering: "pixelated",
                        }}
                      />
                    </div>
                    {frames.length > 1 && (
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
                        <ChevronLeft
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setCurrentIndex((i) => (i - 1 + frames.length) % frames.length)
                          }
                        />
                        {currentIndex + 1} / {frames.length}
                        <ChevronRight
                          className="w-3 h-3 cursor-pointer"
                          onClick={() => setCurrentIndex((i) => (i + 1) % frames.length)}
                        />
                      </div>
                    )}
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <PaletteIcon className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite</p>
                  </div>
                )}
              </div>
              {frames.length > 1 && (
                <Slider
                  value={[currentIndex]}
                  min={0}
                  max={frames.length - 1}
                  step={1}
                  onValueChange={(v) => setCurrentIndex(Array.isArray(v) ? v[0] : v)}
                />
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
// Swatch w/ color picker
// -----------------------------------------------------------------
function PaletteSwatch({
  sourceHex,
  currentHex,
  onChange,
}: {
  sourceHex: string;
  currentHex: string;
  onChange: (hex: string) => void;
}) {
  const changed = sourceHex.toLowerCase() !== currentHex.toLowerCase();
  return (
    <label
      className={cn(
        "flex items-center gap-2 p-1.5 rounded border transition-colors cursor-pointer hover:bg-muted/30",
        changed && "border-primary/60",
      )}
      title={`${sourceHex} → ${currentHex}`}
    >
      <div className="relative w-8 h-8 rounded-sm shrink-0 overflow-hidden border border-border/40">
        <div className="absolute inset-0" style={{ background: sourceHex }} />
        <div
          className="absolute bottom-0 right-0 w-4 h-4 border-l border-t border-white/60"
          style={{ background: currentHex }}
        />
      </div>
      <input
        type="color"
        value={currentHex}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <span className="text-[10px] font-mono truncate">
        {changed ? `${currentHex}` : sourceHex}
      </span>
    </label>
  );
}

// -----------------------------------------------------------------
// Hue shift — lightweight HSL roundtrip
// -----------------------------------------------------------------
function shiftHueOfHex(hex: string, deltaDeg: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const h2 = ((((h * 360 + deltaDeg) % 360) + 360) % 360) / 360;
  const rgb = hslToRgb(h2, s, l);
  return rgbToHex(rgb);
}

function rgbToHsl(r: number, g: number, b: number) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(h + 1 / 3) * 255),
    g: Math.round(hue2rgb(h) * 255),
    b: Math.round(hue2rgb(h - 1 / 3) * 255),
  };
}
