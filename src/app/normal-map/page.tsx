"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  Download,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
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
  DEFAULT_NORMAL_OPTIONS,
  generateNormalMap,
  type NormalMapOptions,
  type NormalSource,
} from "@/lib/normal-map/normal-map";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
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
type PreviewMode = "normal" | "source" | "lit";

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

/**
 * Shade the source sprite with a directional light sampled from the normal
 * map. Cheap Lambert with ambient so back-facing areas aren't pure black.
 */
function litCompose(
  source: ImageData,
  normal: ImageData,
  lightAngleRad: number,
  lightHeight: number,
  ambient: number,
): ImageData {
  const W = source.width;
  const H = source.height;
  const out = new ImageData(W, H);
  const sd = source.data;
  const nd = normal.data;
  const od = out.data;
  const lx = Math.cos(lightAngleRad);
  const ly = Math.sin(lightAngleRad);
  const lz = lightHeight;
  const llen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
  const Lx = lx / llen;
  const Ly = ly / llen;
  const Lz = lz / llen;

  for (let i = 0; i < sd.length; i += 4) {
    const nx = (nd[i] / 255) * 2 - 1;
    const ny = (nd[i + 1] / 255) * 2 - 1;
    const nz = (nd[i + 2] / 255) * 2 - 1;
    const dot = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
    const k = Math.min(1, ambient + (1 - ambient) * dot);
    od[i] = Math.round(sd[i] * k);
    od[i + 1] = Math.round(sd[i + 1] * k);
    od[i + 2] = Math.round(sd[i + 2] * k);
    od[i + 3] = sd[i + 3];
  }
  return out;
}

export default function NormalMapPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<SourceFrame[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [source, setSource] = useState<NormalSource>(DEFAULT_NORMAL_OPTIONS.source);
  const [strength, setStrength] = useState(DEFAULT_NORMAL_OPTIONS.strength * 50); // 0-200
  const [mix, setMix] = useState(Math.round(DEFAULT_NORMAL_OPTIONS.mix * 100));
  const [flipY, setFlipY] = useState(DEFAULT_NORMAL_OPTIONS.flipY);
  const [blur, setBlur] = useState(DEFAULT_NORMAL_OPTIONS.blur);

  // Lit preview state
  const [previewMode, setPreviewMode] = useState<PreviewMode>("normal");
  const [lightAngle, setLightAngle] = useState(45); // degrees
  const [lightHeight, setLightHeight] = useState(0.5);
  const [ambient, setAmbient] = useState(0.2);

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

  // -----------------------------------------------------------------
  // Slice
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
  // Derived: normal maps (auto-recompute on params)
  // -----------------------------------------------------------------
  const normalMaps = useMemo(() => {
    if (frames.length === 0) return [];
    const opts: Partial<NormalMapOptions> = {
      source,
      strength: strength / 50,
      mix: mix / 100,
      flipY,
      blur,
    };
    return frames.map((f) => generateNormalMap(f.imageData, opts));
  }, [frames, source, strength, mix, flipY, blur]);

  // -----------------------------------------------------------------
  // Preview render
  // -----------------------------------------------------------------
  const current = frames[currentIndex];
  const currentNormal = normalMaps[currentIndex];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (previewMode === "source" || !currentNormal) {
      ctx.putImageData(current.imageData, 0, 0);
    } else if (previewMode === "normal") {
      ctx.putImageData(currentNormal, 0, 0);
    } else {
      const lit = litCompose(
        current.imageData,
        currentNormal,
        (lightAngle * Math.PI) / 180,
        lightHeight,
        ambient,
      );
      ctx.putImageData(lit, 0, 0);
    }
  }, [current, currentNormal, previewMode, lightAngle, lightHeight, ambient]);

  // -----------------------------------------------------------------
  // Viewport
  // -----------------------------------------------------------------
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
  // Export
  // -----------------------------------------------------------------
  const downloadCurrent = async () => {
    if (!currentNormal || !sourceFile) return;
    const blob = await imageDataToBlob(currentNormal);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download =
      sourceMode === "sheet" ? `${base}-normal-${currentIndex}.png` : `${base}-normal.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Normal map downloaded");
  };

  const downloadStitched = async () => {
    if (normalMaps.length === 0 || !sourceFile) return;
    const cellW = normalMaps[0].width;
    const cellH = normalMaps[0].height;
    const cols = sourceMode === "sheet" ? effectiveCols : 1;
    const rows = Math.ceil(normalMaps.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cellW * cols;
    canvas.height = cellH * rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    for (let i = 0; i < normalMaps.length; i++) {
      const raw = frames[i];
      const c = raw.cellCol ?? i % cols;
      const r = raw.cellRow ?? Math.floor(i / cols);
      const tmp = document.createElement("canvas");
      tmp.width = cellW;
      tmp.height = cellH;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(normalMaps[i], 0, 0);
      ctx.drawImage(tmp, c * cellW, r * cellH);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-normal-sheet.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Normal sheet downloaded");
  };

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Normals"
        description="Fake surface normals from your sprite's alpha or luminance — drop-in for 2D dynamic lighting."
        icon={Compass}
        category="transform"
        docs="normal-map"
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Any sprite with an alpha channel.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: test */}
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
              <CardTitle>Normal</CardTitle>
              <CardDescription className="text-xs">Live update.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Height source</Label>
                <Select value={source} onValueChange={(v) => v && setSource(v as NormalSource)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="alpha">Alpha distance (puffy)</SelectItem>
                    <SelectItem value="luminance">Luminance (bake shading)</SelectItem>
                    <SelectItem value="mixed">Mixed</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {source === "mixed" && (
                <div className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label className="text-xs">Mix (α → lum)</Label>
                    <span className="text-[10px] font-mono">{mix}%</span>
                  </div>
                  <Slider
                    value={[mix]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(v) => setMix(Array.isArray(v) ? v[0] : v)}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Strength</Label>
                  <span className="text-[10px] font-mono">{(strength / 50).toFixed(2)}</span>
                </div>
                <Slider
                  value={[strength]}
                  min={0}
                  max={200}
                  step={1}
                  onValueChange={(v) => setStrength(Array.isArray(v) ? v[0] : v)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Pre-blur</Label>
                  <span className="text-[10px] font-mono">{blur}px</span>
                </div>
                <Slider
                  value={[blur]}
                  min={0}
                  max={16}
                  step={1}
                  onValueChange={(v) => setBlur(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Smooth the height field before the gradient.
                </p>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Flip Y (DirectX)</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Off = OpenGL / Unity. On = Unreal / Unity DX.
                  </p>
                </div>
                <Switch checked={flipY} onCheckedChange={setFlipY} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Lit preview</CardTitle>
              <CardDescription className="text-xs">
                Move the light to sanity-check the normals.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted/30 border">
                {[
                  { id: "normal" as const, label: "Normal" },
                  { id: "source" as const, label: "Source" },
                  { id: "lit" as const, label: "Lit" },
                ].map(({ id, label }) => (
                  <button
                    type="button"
                    key={id}
                    onClick={() => setPreviewMode(id)}
                    className={cn(
                      "py-1.5 text-xs font-medium rounded-md transition-colors",
                      previewMode === id
                        ? "bg-background shadow-sm text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {previewMode === "lit" && (
                <>
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <Label className="text-xs">Light angle</Label>
                      <span className="text-[10px] font-mono">{lightAngle}°</span>
                    </div>
                    <Slider
                      value={[lightAngle]}
                      min={0}
                      max={359}
                      step={1}
                      onValueChange={(v) => setLightAngle(Array.isArray(v) ? v[0] : v)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <Label className="text-xs">Light elevation</Label>
                      <span className="text-[10px] font-mono">{lightHeight.toFixed(2)}</span>
                    </div>
                    <Slider
                      value={[Math.round(lightHeight * 100)]}
                      min={0}
                      max={200}
                      step={1}
                      onValueChange={(v) => setLightHeight((Array.isArray(v) ? v[0] : v) / 100)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <Label className="text-xs">Ambient</Label>
                      <span className="text-[10px] font-mono">{ambient.toFixed(2)}</span>
                    </div>
                    <Slider
                      value={[Math.round(ambient * 100)]}
                      min={0}
                      max={100}
                      step={1}
                      onValueChange={(v) => setAmbient((Array.isArray(v) ? v[0] : v) / 100)}
                    />
                  </div>
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
                  <Download className="w-4 h-4 mr-2" /> Download current frame
                </Button>
                {frames.length > 1 && (
                  <Button onClick={downloadStitched} variant="outline" className="w-full">
                    <Grid3x3 className="w-4 h-4 mr-2" /> Download normal sheet
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
                    <Compass className="w-10 h-10 opacity-30 mb-2" />
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
