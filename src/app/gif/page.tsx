"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
  Pause,
  Play,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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

function findTransparentIndex(palette: number[][]): number {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i][3] === 0) return i;
  }
  return 0;
}

export default function GifPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("sheet");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<SourceFrame[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fps, setFps] = useState(10);
  const [scale, setScale] = useState(1);
  const [alphaThreshold, setAlphaThreshold] = useState(128);
  const [reverse, setReverse] = useState(false);
  const [pingpong, setPingpong] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isEncoding, setIsEncoding] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState(0);
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

  // Sequence used for playback + export.
  const sequence = useMemo<number[]>(() => {
    if (frames.length === 0) return [];
    const fwd = Array.from({ length: frames.length }, (_, i) => i);
    const base = reverse ? fwd.slice().reverse() : fwd;
    if (!pingpong) return base;
    return [...base, ...base.slice(1, -1).reverse()];
  }, [frames.length, reverse, pingpong]);

  // Preview canvas
  const current = frames[sequence[currentIndex] ?? 0];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(current.imageData, 0, 0);
  }, [current]);

  // Playback
  useEffect(() => {
    if (!isPlaying || sequence.length === 0) {
      if (playbackRef.current) {
        window.clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
      return;
    }
    playbackRef.current = window.setInterval(() => {
      setCurrentIndex((i) => (i + 1) % sequence.length);
    }, Math.max(16, Math.round(1000 / Math.max(1, fps))));
    return () => {
      if (playbackRef.current) {
        window.clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
    };
  }, [isPlaying, fps, sequence.length]);

  // Viewport
  useEffect(() => {
    if (!current || hasAutoFittedRef.current || !previewContainerRef.current) return;
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

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  const exportGif = async () => {
    if (sequence.length === 0 || !sourceFile) return;
    setIsEncoding(true);
    setEncodeProgress(0);
    try {
      // Pull frame image data in the active sequence order.
      const orderedFrames: ImageData[] = [];
      for (let i = 0; i < sequence.length; i++) {
        orderedFrames.push(frames[sequence[i]].imageData);
      }

      // Drip progress based on frame processing.
      let processed = 0;
      const total = orderedFrames.length;
      const bytes = await encodeGifWithProgress(
        orderedFrames,
        fps,
        scale,
        alphaThreshold,
        () => {
          processed += 1;
          setEncodeProgress((processed / total) * 100);
        },
      );

      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/gif" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const base = sourceFile.name.replace(/\.[^.]+$/, "");
      a.download = `${base}.gif`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("GIF downloaded");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsEncoding(false);
      setEncodeProgress(0);
    }
  };

  // Same as encodeGif but with a per-frame callback for progress.
  const encodeGifWithProgress = async (
    framesIn: ImageData[],
    fps: number,
    scale: number,
    alphaThresh: number,
    onFrame: () => void,
  ): Promise<Uint8Array> => {
    if (framesIn.length === 0) return new Uint8Array();
    const src0 = framesIn[0];
    const W = src0.width * scale;
    const H = src0.height * scale;
    const delay = Math.max(20, Math.round(1000 / Math.max(1, fps)));
    const enc = GIFEncoder();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.imageSmoothingEnabled = false;

    for (const f of framesIn) {
      const tmp = document.createElement("canvas");
      tmp.width = f.width;
      tmp.height = f.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(f, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(tmp, 0, 0, W, H);
      const big = ctx.getImageData(0, 0, W, H);
      const d = big.data;
      for (let i = 3; i < d.length; i += 4) {
        d[i] = d[i] > alphaThresh ? 255 : 0;
      }
      const palette = quantize(d, 256, { format: "rgba4444" });
      const index = applyPalette(d, palette, "rgba4444");
      enc.writeFrame(index, W, H, {
        palette,
        delay,
        transparent: true,
        transparentIndex: findTransparentIndex(palette),
        dispose: 2,
      });
      onFrame();
      await new Promise((r) => setTimeout(r));
    }
    enc.finish();
    return enc.bytes();
  };

  const exportWebm = async () => {
    if (sequence.length === 0 || !sourceFile) return;
    if (typeof MediaRecorder === "undefined") {
      toast.error("MediaRecorder not supported in this browser.");
      return;
    }
    setIsEncoding(true);
    try {
      const w = frames[0].width * scale;
      const h = frames[0].height * scale;
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const cx = cv.getContext("2d")!;
      cx.imageSmoothingEnabled = false;

      const stream = cv.captureStream(fps);
      const chunks: Blob[] = [];
      const mimes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      const mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();

      const delay = 1000 / Math.max(1, fps);
      for (let i = 0; i < sequence.length; i++) {
        const f = frames[sequence[i]].imageData;
        const tmp = document.createElement("canvas");
        tmp.width = f.width;
        tmp.height = f.height;
        tmp.getContext("2d")!.putImageData(f, 0, 0);
        cx.clearRect(0, 0, w, h);
        cx.drawImage(tmp, 0, 0, w, h);
        await new Promise((r) => setTimeout(r, delay));
      }
      recorder.stop();
      await done;

      const blob = new Blob(chunks, { type: mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const base = sourceFile.name.replace(/\.[^.]+$/, "");
      a.download = `${base}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("WebM downloaded");
    } catch (e) {
      toast.error(`WebM export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsEncoding(false);
    }
  };

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="GIF"
        description="Turn a sprite sheet into an animated GIF or WebM for previews and sharing."
        icon={Film}
        category="export"
        docs="gif"
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
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
              <CardTitle>Animation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">FPS</Label>
                  <span className="text-[10px] font-mono">{fps}</span>
                </div>
                <Slider
                  value={[fps]}
                  min={1}
                  max={60}
                  step={1}
                  onValueChange={(v) => setFps(Array.isArray(v) ? v[0] : v)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Scale</Label>
                  <span className="text-[10px] font-mono">{scale}×</span>
                </div>
                <Slider
                  value={[scale]}
                  min={1}
                  max={8}
                  step={1}
                  onValueChange={(v) => setScale(Array.isArray(v) ? v[0] : v)}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Alpha cutoff (GIF)</Label>
                  <span className="text-[10px] font-mono">{alphaThreshold}</span>
                </div>
                <Slider
                  value={[alphaThreshold]}
                  min={1}
                  max={254}
                  step={1}
                  onValueChange={(v) =>
                    setAlphaThreshold(Array.isArray(v) ? v[0] : v)
                  }
                />
                <p className="text-[10px] text-muted-foreground">
                  GIF can&rsquo;t do partial transparency — pixels above this are fully opaque.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center justify-between p-2 rounded-lg border bg-muted/5">
                  <span className="text-xs">Reverse</span>
                  <Switch checked={reverse} onCheckedChange={setReverse} />
                </label>
                <label className="flex items-center justify-between p-2 rounded-lg border bg-muted/5">
                  <span className="text-xs">Pingpong</span>
                  <Switch checked={pingpong} onCheckedChange={setPingpong} />
                </label>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setIsPlaying((p) => !p)}
                disabled={frames.length === 0}
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-4 h-4 mr-2" /> Pause preview
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" /> Play preview
                  </>
                )}
              </Button>
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
                <Button
                  onClick={exportGif}
                  disabled={isEncoding}
                  className="w-full"
                >
                  {isEncoding ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Encoding…
                      {encodeProgress > 0 && ` ${encodeProgress.toFixed(0)}%`}
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 mr-2" /> Download GIF
                    </>
                  )}
                </Button>
                <Button
                  onClick={exportWebm}
                  disabled={isEncoding}
                  variant="outline"
                  className="w-full"
                >
                  <Film className="w-4 h-4 mr-2" /> Download WebM
                </Button>
                <p className="text-[10px] text-muted-foreground pt-1">
                  {sequence.length} frames • {fps} FPS •{" "}
                  {(sequence.length / fps).toFixed(2)}s
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
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      {currentIndex + 1} / {sequence.length}
                    </div>
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Film className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a sprite sheet</p>
                  </div>
                )}
              </div>
              {sequence.length > 1 && (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setIsPlaying(false);
                      setCurrentIndex((i) => (i - 1 + sequence.length) % sequence.length);
                    }}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Slider
                    className="flex-1"
                    value={[currentIndex]}
                    min={0}
                    max={sequence.length - 1}
                    step={1}
                    onValueChange={(v) => {
                      setIsPlaying(false);
                      setCurrentIndex(Array.isArray(v) ? v[0] : v);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setIsPlaying(false);
                      setCurrentIndex((i) => (i + 1) % sequence.length);
                    }}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
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
