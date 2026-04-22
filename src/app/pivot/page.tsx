"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Crosshair,
  Download,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
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
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";

interface PivotFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  imageData: ImageData;
}

interface Pivot {
  x: number;
  y: number;
}

type SourceMode = "single" | "sheet";

interface PivotPreset {
  id: string;
  name: string;
  nx: number; // normalized x in [0,1]
  ny: number; // normalized y in [0,1]
}

const PRESETS: PivotPreset[] = [
  { id: "center", name: "Center", nx: 0.5, ny: 0.5 },
  { id: "top-center", name: "Top center", nx: 0.5, ny: 0 },
  { id: "top-left", name: "Top left", nx: 0, ny: 0 },
  { id: "top-right", name: "Top right", nx: 1, ny: 0 },
  { id: "bottom-center", name: "Bottom center (feet)", nx: 0.5, ny: 1 },
  { id: "bottom-left", name: "Bottom left", nx: 0, ny: 1 },
  { id: "bottom-right", name: "Bottom right", nx: 1, ny: 1 },
];

async function frameToImageData(frame: Frame): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  return ctx.getImageData(0, 0, frame.width, frame.height);
}

function applyPreset(preset: PivotPreset, w: number, h: number): Pivot {
  return {
    x: Math.round(preset.nx * (w - 1)),
    y: Math.round(preset.ny * (h - 1)),
  };
}

export default function PivotPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<PivotFrame[]>([]);
  const [pivots, setPivots] = useState<Pivot[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lockAll, setLockAll] = useState(false); // apply every click to all frames
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
  // Slice + initialize pivots to bottom-center
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!sourceFile) {
      setFrames([]);
      setPivots([]);
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
        const out: PivotFrame[] = [];
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
        // Default: bottom-center (common foot-anchor for characters).
        const bc = PRESETS.find((p) => p.id === "bottom-center")!;
        setPivots(out.map((f) => applyPreset(bc, f.width, f.height)));
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
  // Canvas rendering — sprite + crosshair
  // -----------------------------------------------------------------
  const currentFrame = frames[currentIndex];
  const currentPivot = pivots[currentIndex];
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

    if (!currentPivot) return;
    const { x, y } = currentPivot;
    ctx.save();

    // Crosshair — full-width/height lines so the pivot is easy to align visually
    ctx.strokeStyle = "rgba(239, 68, 68, 0.7)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
    ctx.stroke();

    // Ring at the pivot
    ctx.strokeStyle = "rgba(239, 68, 68, 1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 68, 68, 1)";
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }, [currentFrame, currentPivot]);

  // -----------------------------------------------------------------
  // Click to set pivot
  // -----------------------------------------------------------------
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!currentFrame) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / rect.width;
    const sy = (e.clientY - rect.top) / rect.height;
    const x = Math.max(0, Math.min(currentFrame.width - 1, Math.floor(sx * currentFrame.width)));
    const y = Math.max(0, Math.min(currentFrame.height - 1, Math.floor(sy * currentFrame.height)));
    setPivot({ x, y });
  };

  const setPivot = (p: Pivot) => {
    setPivots((prev) => {
      const next = [...prev];
      if (lockAll) {
        for (let i = 0; i < next.length; i++) next[i] = { ...p };
      } else {
        next[currentIndex] = p;
      }
      return next;
    });
  };

  const applyPresetToCurrent = (preset: PivotPreset) => {
    if (!currentFrame) return;
    setPivot(applyPreset(preset, currentFrame.width, currentFrame.height));
  };

  const applyPresetToAll = (preset: PivotPreset) => {
    setPivots(frames.map((f) => applyPreset(preset, f.width, f.height)));
    toast.success(`Set ${preset.name} on all frames`);
  };

  const copyFromCurrentToAll = () => {
    if (!currentPivot) return;
    setPivots(frames.map(() => ({ ...currentPivot })));
    toast.success("Copied to all frames");
  };

  // -----------------------------------------------------------------
  // Arrow keys — nudge current pivot by 1px
  // -----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!currentFrame || !currentPivot) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowDown") dy = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "PageDown" || e.key === "[") {
        e.preventDefault();
        setCurrentIndex((i) => (i - 1 + frames.length) % frames.length);
        return;
      } else if (e.key === "PageUp" || e.key === "]") {
        e.preventDefault();
        setCurrentIndex((i) => (i + 1) % frames.length);
        return;
      } else {
        return;
      }
      e.preventDefault();
      setPivot({
        x: Math.max(0, Math.min(currentFrame.width - 1, currentPivot.x + dx)),
        y: Math.max(0, Math.min(currentFrame.height - 1, currentPivot.y + dy)),
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, currentPivot, frames.length, lockAll, currentIndex]);

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
  // Export
  // -----------------------------------------------------------------
  // Same shape as `sprite-tools pivot` CLI output.
  const jsonPayload = useMemo(() => {
    if (frames.length === 0 || !sourceFile) return null;
    const f0 = frames[0];
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      pivots: frames.map((f, i) => ({
        index: f.index,
        cell:
          f.cellRow != null && f.cellCol != null
            ? { row: f.cellRow, col: f.cellCol }
            : { row: Math.floor(f.index / sheetCols), col: f.index % sheetCols },
        pivot: pivots[i] ?? { x: 0, y: 0 },
      })),
    };
  }, [frames, pivots, sourceFile, sourceMode, sheetCols, sheetRows]);

  const downloadJson = () => {
    if (!jsonPayload || !sourceFile) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-pivots.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Pivot JSON downloaded");
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
      <ToolHeader
        title="Pivot"
        description="Click to set the anchor point for each frame — export as JSON for rotation and scaling origins."
        icon={Crosshair}
        category="metadata"
        docs="pivot"
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Upload a sprite or sheet.
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

              <SampleSprites />

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
              <CardTitle>Controls</CardTitle>
              <CardDescription className="text-xs">
                Click the preview to set the pivot. Arrow keys nudge by 1px (Shift = 10px).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Lock to all frames</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Every click / nudge applies to every frame.
                  </p>
                </div>
                <Switch checked={lockAll} onCheckedChange={setLockAll} />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground/70">
                  Preset — current frame
                </Label>
                <div className="grid grid-cols-3 gap-1">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.id}
                      size="sm"
                      variant="outline"
                      className="h-8 text-[10px]"
                      onClick={() => applyPresetToCurrent(p)}
                    >
                      {p.name}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground/70">
                  Preset — all frames
                </Label>
                <div className="grid grid-cols-3 gap-1">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.id}
                      size="sm"
                      variant="secondary"
                      className="h-8 text-[10px]"
                      onClick={() => applyPresetToAll(p)}
                    >
                      {p.name}
                    </Button>
                  ))}
                </div>
              </div>

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={copyFromCurrentToAll}
                disabled={frames.length < 2}
              >
                <Copy className="w-3.5 h-3.5 mr-2" />
                Copy current pivot to all
              </Button>

              {currentFrame && currentPivot && (
                <div className="space-y-3 border-t border-dashed pt-4">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground/70">
                    Fine-tune
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <Label className="text-xs">X</Label>
                        <span className="text-[10px] font-mono">{currentPivot.x}</span>
                      </div>
                      <Slider
                        value={[currentPivot.x]}
                        min={0}
                        max={currentFrame.width - 1}
                        step={1}
                        onValueChange={(v) => {
                          const x = Array.isArray(v) ? v[0] : v;
                          setPivot({ x, y: currentPivot.y });
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between">
                        <Label className="text-xs">Y</Label>
                        <span className="text-[10px] font-mono">{currentPivot.y}</span>
                      </div>
                      <Slider
                        value={[currentPivot.y]}
                        min={0}
                        max={currentFrame.height - 1}
                        step={1}
                        onValueChange={(v) => {
                          const y = Array.isArray(v) ? v[0] : v;
                          setPivot({ x: currentPivot.x, y });
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
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
                  "aspect-video min-h-96 rounded-lg border overflow-hidden relative cursor-crosshair touch-none",
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
                        onClick={handleCanvasClick}
                        className="block cursor-crosshair"
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
                          onClick={() => setCurrentIndex((i) => (i + 1) % frames.length)}
                        />
                      </div>
                    )}
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                    {currentPivot && (
                      <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                        pivot: {currentPivot.x}, {currentPivot.y}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Crosshair className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite to set its pivot</p>
                  </div>
                )}
              </div>

              {frames.length > 1 && (
                <Slider
                  className="flex-1"
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
