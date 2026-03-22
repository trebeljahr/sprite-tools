"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  Upload,
  Scissors,
  LayoutGrid,
  Download,
  Loader2,
  Play,
  Pause,
  RefreshCw,
  Video as VideoIcon,
  ImageIcon,
  MonitorPlay,
  ZoomIn,
  ZoomOut,
  Maximize,
  CheckCircle2,
  Circle,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export default function SpritesheetPage() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  // Frame Management
  const [rawFrames, setRawFrames] = useState<string[]>([]);
  const [processedFrames, setProcessedFrames] = useState<string[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    new Set(),
  );

  const [isExtracting, setIsExtracting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [smoothProgress, setSmoothProgress] = useState(0);

  const [fps, setFps] = useState(10);
  const [columns, setColumns] = useState(8);
  const [spritesheetUrl, setSpritesheetUrl] = useState<string | null>(null);

  // Background Removal Settings
  const [removeBackground, setRemoveBackground] = useState(true);
  const [similarity, setSimilarity] = useState(30);
  const [softness, setSoftness] = useState(10);
  const [spill, setSpill] = useState(20);
  const [choke, setChoke] = useState(0);

  // Animation Preview State
  const [previewIndex, setPreviewIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const playbackRef = useRef<NodeJS.Timeout | null>(null);

  // Sprite Sheet Preview State
  const [sheetZoom, setSheetZoom] = useState(1);
  const [sheetPan, setSheetPan] = useState({ x: 0, y: 0 });
  const [isPanningSheet, setIsPanningSheet] = useState(false);

  // Drag Selection State
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [dragAction, setDragAction] = useState<"select" | "deselect" | null>(
    null,
  );

  // Background Grid Theme
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");

  const activeFrames = useMemo(() => {
    return processedFrames.filter((_, i) => selectedIndices.has(i));
  }, [processedFrames, selectedIndices]);

  const previewContainerRef = useRef<HTMLDivElement>(null);
  const sheetContainerRef = useRef<HTMLDivElement>(null);

  // Progress Smoothing (Lerp)
  useEffect(() => {
    if (smoothProgress < progress) {
      const timeout = setTimeout(() => {
        setSmoothProgress((prev) => Math.min(progress, prev + 1));
      }, 20);
      return () => clearTimeout(timeout);
    }
  }, [progress, smoothProgress]);

  // Handle progress reset separately to avoid useEffect warnings
  useEffect(() => {
    if (progress === 0 && smoothProgress !== 0) {
      setSmoothProgress(0);
    }
  }, [progress]);

  // Prevent Default Wheel Zoom
  useEffect(() => {
    const preventDefault = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const preview = previewContainerRef.current;
    const sheet = sheetContainerRef.current;
    if (preview)
      preview.addEventListener("wheel", preventDefault, { passive: false });
    if (sheet)
      sheet.addEventListener("wheel", preventDefault, { passive: false });
    return () => {
      if (preview) preview.removeEventListener("wheel", preventDefault);
      if (sheet) sheet.removeEventListener("wheel", preventDefault);
    };
  }, []);

  // Adjust previewIndex if it goes out of bounds
  useEffect(() => {
    if (activeFrames.length > 0 && previewIndex >= activeFrames.length) {
      setPreviewIndex(0);
    }
  }, [activeFrames.length]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeFrames.length === 0) return;
      if (e.key === "ArrowRight") {
        setPreviewIndex((prev) => (prev + 1) % activeFrames.length);
        setIsPlaying(false);
      } else if (e.key === "ArrowLeft") {
        setPreviewIndex(
          (prev) => (prev - 1 + activeFrames.length) % activeFrames.length,
        );
        setIsPlaying(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFrames.length]);

  // Animation Playback
  useEffect(() => {
    if (isPlaying && activeFrames.length > 0) {
      playbackRef.current = setInterval(() => {
        setPreviewIndex((prev) => (prev + 1) % activeFrames.length);
      }, 1000 / fps);
    } else if (playbackRef.current) {
      clearInterval(playbackRef.current);
    }
    return () => {
      if (playbackRef.current) clearInterval(playbackRef.current);
    };
  }, [isPlaying, activeFrames.length, fps]);

  // Global Mouse Up for Drag Selection
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      setIsDraggingSelection(false);
      setDragAction(null);
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setRawFrames([]);
      setProcessedFrames([]);
      setSpritesheetUrl(null);
      setPreviewIndex(0);
      setIsPlaying(false);
      setProgress(0);
    }
  };

  const extractFrames = async () => {
    if (!videoUrl) return;
    setIsExtracting(true);
    setProgress(0);
    setRawFrames([]);
    setProcessedFrames([]);
    setSpritesheetUrl(null);
    setIsPlaying(false);

    const video = document.createElement("video");
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    await new Promise((resolve) => (video.onloadedmetadata = resolve));

    const duration = video.duration;
    const totalFramesCount = Math.floor(duration * fps);
    const frameInterval = 1 / fps;
    const extracted: string[] = [];

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    for (let i = 0; i < totalFramesCount; i++) {
      video.currentTime = i * frameInterval;
      await new Promise((resolve) => (video.onseeked = resolve));
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        extracted.push(canvas.toDataURL("image/png"));
      }
      setProgress(Math.round(((i + 1) / totalFramesCount) * 50));
    }

    setRawFrames(extracted);
    setSelectedIndices(new Set(extracted.map((_, i) => i)));
    setIsExtracting(false);
    await processFrames(extracted, true);
    toast.success(`Extracted and processed ${extracted.length} frames!`);
  };

  const processFrames = async (sourceFrames = rawFrames, isInitial = false) => {
    if (sourceFrames.length === 0) return;
    setIsProcessing(true);
    if (!isInitial) setProgress(0);

    const processed: string[] = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    if (sourceFrames.length > 0) {
      const img = new Image();
      img.src = sourceFrames[0];
      await new Promise((resolve) => (img.onload = resolve));
      canvas.width = img.width;
      canvas.height = img.height;
    }

    for (let i = 0; i < sourceFrames.length; i++) {
      const frameImg = new Image();
      frameImg.src = sourceFrames[i];
      await new Promise((resolve) => (frameImg.onload = resolve));

      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frameImg, 0, 0);

        if (removeBackground) {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;

          const corners = [
            { r: data[0], g: data[1], b: data[2] },
            {
              r: data[(canvas.width - 1) * 4],
              g: data[(canvas.width - 1) * 4 + 1],
              b: data[(canvas.width - 1) * 4 + 2],
            },
            {
              r: data[data.length - canvas.width * 4],
              g: data[data.length - canvas.width * 4 + 1],
              b: data[data.length - canvas.width * 4 + 2],
            },
            {
              r: data[data.length - 4],
              g: data[data.length - 3],
              b: data[data.length - 2],
            },
          ];

          const colorCounts: Record<
            string,
            { r: number; g: number; b: number; count: number }
          > = {};
          corners.forEach((c) => {
            const key = `${c.r},${c.g},${c.b}`;
            colorCounts[key] = colorCounts[key]
              ? { ...c, count: colorCounts[key].count + 1 }
              : { ...c, count: 1 };
          });

          let target = corners[0];
          let maxCount = 0;
          for (const key in colorCounts) {
            if (colorCounts[key].count > maxCount) {
              maxCount = colorCounts[key].count;
              target = colorCounts[key];
            }
          }

          const targetR = target.r,
            targetG = target.g,
            targetB = target.b;

          for (let j = 0; j < data.length; j += 4) {
            const r = data[j],
              g = data[j + 1],
              b = data[j + 2];
            const dist = Math.sqrt(
              Math.pow(r - targetR, 2) +
                Math.pow(g - targetG, 2) +
                Math.pow(b - targetB, 2),
            );
            if (dist < similarity) data[j + 3] = 0;
            else if (dist < similarity + softness) {
              data[j + 3] = Math.min(
                data[j + 3],
                ((dist - similarity) / softness) * 255,
              );
            }
            if (dist < similarity + softness + spill) {
              const sf =
                1 -
                Math.max(
                  0,
                  Math.min(1, (dist - similarity) / (softness + spill)),
                );
              const gray = (r + g + b) / 3;
              data[j] = r * (1 - sf) + gray * sf;
              data[j + 1] = g * (1 - sf) + gray * sf;
              data[j + 2] = b * (1 - sf) + gray * sf;
            }
          }

          if (choke > 0) {
            const originalAlphas = new Uint8Array(data.length / 4);
            for (let k = 0; k < originalAlphas.length; k++)
              originalAlphas[k] = data[k * 4 + 3];
            for (let y = 0; y < canvas.height; y++) {
              for (let x = 0; x < canvas.width; x++) {
                const idx = (y * canvas.width + x) * 4;
                if (data[idx + 3] === 0) continue;
                let minAlpha = data[idx + 3];
                for (let dy = -choke; dy <= choke; dy++) {
                  for (let dx = -choke; dx <= choke; dx++) {
                    const ny = y + dy,
                      nx = x + dx;
                    if (
                      ny >= 0 &&
                      ny < canvas.height &&
                      nx >= 0 &&
                      nx < canvas.width
                    ) {
                      const nAlpha = originalAlphas[ny * canvas.width + nx];
                      if (nAlpha < minAlpha) minAlpha = nAlpha;
                    }
                  }
                }
                data[idx + 3] = minAlpha;
              }
            }
          }
          ctx.putImageData(imageData, 0, 0);
        }
        processed.push(canvas.toDataURL("image/png"));
      }
      const stepProgress = Math.round(
        ((i + 1) / sourceFrames.length) * (isInitial ? 50 : 100),
      );
      setProgress(isInitial ? 50 + stepProgress : stepProgress);
    }
    setProcessedFrames(processed);
    setIsProcessing(false);
    if (!isInitial) toast.success("Frames processed!");
  };

  const generateSpritesheet = async () => {
    const activeFramesList = processedFrames.filter((_, i) =>
      selectedIndices.has(i),
    );
    if (activeFramesList.length === 0) {
      setSpritesheetUrl(null);
      return;
    }
    const img = new Image();
    img.src = activeFramesList[0];
    await new Promise((resolve) => (img.onload = resolve));
    const fw = img.width,
      fh = img.height;
    const rows = Math.ceil(activeFramesList.length / columns);
    const canvas = document.createElement("canvas");
    canvas.width = columns * fw;
    canvas.height = rows * fh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    for (let i = 0; i < activeFramesList.length; i++) {
      const fImg = new Image();
      fImg.src = activeFramesList[i];
      await new Promise((resolve) => (fImg.onload = resolve));
      ctx.drawImage(fImg, (i % columns) * fw, Math.floor(i / columns) * fh);
    }
    setSpritesheetUrl(canvas.toDataURL("image/png"));
  };

  const handleFrameMouseDown = (index: number) => {
    const action = selectedIndices.has(index) ? "deselect" : "select";
    setIsDraggingSelection(true);
    setDragAction(action);
    const next = new Set(selectedIndices);
    if (action === "select") next.add(index);
    else next.delete(index);
    setSelectedIndices(next);
  };

  const handleFrameMouseEnter = (index: number) => {
    if (!isDraggingSelection || !dragAction) return;
    const next = new Set(selectedIndices);
    if (dragAction === "select") next.add(index);
    else next.delete(index);
    setSelectedIndices(next);
  };

  const handleWheel = (
    e: React.WheelEvent | WheelEvent,
    type: "preview" | "sheet",
  ) => {
    const isCtrl = "ctrlKey" in e ? e.ctrlKey : false;
    if (isCtrl) {
      const delta = -e.deltaY * 0.01;
      if (type === "preview")
        setZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
      else setSheetZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
    }
  };

  const [touchStartDist, setTouchStartDist] = useState<number | null>(null);
  const handleTouchMove = (e: React.TouchEvent, type: "preview" | "sheet") => {
    if (e.touches.length === 2) {
      if (e.cancelable) e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].pageX - e.touches[1].pageX,
        e.touches[0].pageY - e.touches[1].pageY,
      );
      if (touchStartDist === null) {
        setTouchStartDist(dist);
      } else {
        const delta = (dist - touchStartDist) * 0.01;
        if (type === "preview")
          setZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
        else setSheetZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
        setTouchStartDist(dist);
      }
    }
  };
  const handleTouchEnd = () => setTouchStartDist(null);

  const handleZoom = (delta: number) => {
    setZoom((prev) => Math.max(0.5, Math.min(5, prev + delta)));
  };

  const downloadSpritesheet = () => {
    if (!spritesheetUrl) return;
    const link = document.createElement("a");
    link.href = spritesheetUrl;
    link.download = "spritesheet.png";
    link.click();
  };

  const [isPanning, setIsPanning] = useState(false);
  const handleMouseDown = () => setIsPanning(true);
  const handleMouseUp = () => setIsPanning(false);
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan((prev) => ({
      x: prev.x + e.movementX / zoom,
      y: prev.y + e.movementY / zoom,
    }));
  };

  return (
    <main className="flex-1 container max-w-7xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Advanced Sprite Tools
        </h1>
        <p className="text-muted-foreground">
          Extract, filter, and stitch animation sheets with pixel-perfect
          control.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source & Extraction</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div
                className={cn(
                  "border-2 border-dashed rounded-lg overflow-hidden flex flex-col items-center justify-center cursor-pointer transition-colors relative",
                  videoUrl
                    ? "border-primary/50 aspect-video"
                    : "border-muted-foreground/20 hover:border-primary/50 p-6",
                )}
                onClick={() =>
                  !videoUrl && document.getElementById("video-upload")?.click()
                }
              >
                {videoUrl ? (
                  <>
                    <video
                      src={videoUrl}
                      className="w-full h-full object-cover"
                      muted
                      loop
                      autoPlay
                    />
                    <div
                      className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        document.getElementById("video-upload")?.click();
                      }}
                    >
                      <RefreshCw className="w-8 h-8 text-white" />
                    </div>
                  </>
                ) : (
                  <div className="text-center">
                    <Upload className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
                    <p className="text-sm text-muted-foreground">
                      Upload Video
                    </p>
                  </div>
                )}
                <Input
                  id="video-upload"
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Label>Extraction FPS</Label>
                    <span className="text-sm font-medium bg-muted px-2 py-0.5 rounded">
                      {fps}
                    </span>
                  </div>
                  <Slider
                    value={[fps]}
                    min={1}
                    max={60}
                    step={1}
                    onValueChange={(val) => setFps(val as number)}
                  />
                </div>
                <Button
                  onClick={extractFrames}
                  disabled={isExtracting || !videoUrl}
                  className="w-full"
                >
                  {isExtracting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Scissors className="mr-2 h-4 w-4" />
                  )}
                  Extract Raw Frames
                </Button>
                {(isExtracting || isProcessing) && (
                  <div className="space-y-2 pt-2">
                    <div className="flex justify-between text-[10px] font-medium uppercase tracking-wider">
                      {smoothProgress === 100 ? (
                        <span className="text-primary animate-pulse font-bold">
                          Finishing up...
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {isExtracting
                            ? "Extracting Video..."
                            : "Applying Filters..."}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {smoothProgress}%
                      </span>
                    </div>
                    <Progress value={smoothProgress} className="h-1.5" />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Chroma Filtering</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Remove Background</Label>
                  <p className="text-xs text-muted-foreground">
                    Sampling corners
                  </p>
                </div>
                <Switch
                  checked={removeBackground}
                  onCheckedChange={setRemoveBackground}
                />
              </div>
              {removeBackground && (
                <div className="space-y-4 pt-2">
                  {[
                    {
                      label: "Similarity",
                      val: similarity,
                      set: setSimilarity,
                      max: 150,
                    },
                    {
                      label: "Edge Softness",
                      val: softness,
                      set: setSoftness,
                      max: 50,
                    },
                    {
                      label: "Color Spill",
                      val: spill,
                      set: setSpill,
                      max: 100,
                    },
                    { label: "Mask Choke", val: choke, set: setChoke, max: 5 },
                  ].map((s) => (
                    <div key={s.label} className="space-y-2">
                      <div className="flex justify-between">
                        <Label className="text-xs">{s.label}</Label>
                        <span className="text-[10px] font-mono">{s.val}</span>
                      </div>
                      <Slider
                        value={[s.val]}
                        min={0}
                        max={s.max}
                        step={1}
                        onValueChange={(v) => s.set(v as number)}
                      />
                    </div>
                  ))}
                </div>
              )}
              <Button
                onClick={() => processFrames()}
                disabled={isProcessing || rawFrames.length === 0}
                variant="outline"
                className="w-full"
              >
                {isProcessing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4 text-primary" />
                )}
                Re-process Frames
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-8 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="md:col-span-1">
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">Preview</CardTitle>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Toggle Background Grid"
                    onClick={() =>
                      setGridTheme((prev) =>
                        prev === "light" ? "dark" : "light",
                      )
                    }
                  >
                    <LayoutGrid
                      className={cn(
                        "h-4 w-4",
                        gridTheme === "dark"
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                    />
                  </Button>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setZoom((prev) => Math.max(0.5, prev - 0.2))}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    <Maximize className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setZoom((prev) => Math.min(5, prev + 0.2))}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  ref={previewContainerRef}
                  className={cn(
                    "aspect-square rounded-lg bg-muted/30 border flex items-center justify-center overflow-hidden relative cursor-move touch-none",
                    gridTheme === "light"
                      ? "checkerboard-light"
                      : "checkerboard-dark",
                  )}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onWheel={(e) => handleWheel(e, "preview")}
                  onTouchMove={(e) => handleTouchMove(e, "preview")}
                  onTouchEnd={handleTouchEnd}
                >
                  {activeFrames.length > 0 ? (
                    <>
                      <img
                        src={activeFrames[previewIndex]}
                        alt="Preview"
                        className="object-contain transition-transform duration-200"
                        style={{
                          transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`,
                        }}
                        draggable={false}
                      />
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-[10px] px-3 py-1.5 rounded-full font-mono">
                        <ChevronLeft
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setPreviewIndex(
                              (p) =>
                                (p - 1 + activeFrames.length) %
                                activeFrames.length,
                            )
                          }
                        />
                        {previewIndex + 1} / {activeFrames.length}
                        <ChevronRight
                          className="w-3 h-3 cursor-pointer"
                          onClick={() =>
                            setPreviewIndex(
                              (p) => (p + 1) % activeFrames.length,
                            )
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <div className="text-center p-6 text-muted-foreground text-sm">
                      No selected frames
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => setIsPlaying(!isPlaying)}
                    disabled={activeFrames.length === 0}
                  >
                    {isPlaying ? (
                      <Pause className="w-4 h-4" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                  </Button>
                  <Slider
                    className="flex-1"
                    value={[previewIndex]}
                    min={0}
                    max={Math.max(0, activeFrames.length - 1)}
                    step={1}
                    onValueChange={(val) => {
                      setPreviewIndex(val as number);
                      setIsPlaying(false);
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <Card
              className={cn(
                "md:col-span-1",
                processedFrames.length === 0 && "opacity-50",
              )}
            >
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">Sprite Sheet</CardTitle>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Toggle Background Grid"
                    onClick={() =>
                      setGridTheme((prev) =>
                        prev === "light" ? "dark" : "light",
                      )
                    }
                  >
                    <LayoutGrid
                      className={cn(
                        "h-4 w-4",
                        gridTheme === "dark"
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                    />
                  </Button>
                </div>
                <div className="flex gap-1 items-center">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() =>
                      setSheetZoom((prev) => Math.max(0.5, prev - 0.2))
                    }
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      setSheetZoom(1);
                      setSheetPan({ x: 0, y: 0 });
                    }}
                  >
                    <Maximize className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() =>
                      setSheetZoom((prev) => Math.min(5, prev + 0.2))
                    }
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                  <div className="w-px h-4 bg-border mx-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] gap-1 px-2"
                    onClick={generateSpritesheet}
                    disabled={processedFrames.length === 0}
                  >
                    <RefreshCw className="w-3 h-3" />
                    Compile
                  </Button>
                  {spritesheetUrl && (
                    <Button
                      onClick={downloadSpritesheet}
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 ml-1"
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  ref={sheetContainerRef}
                  className={cn(
                    "aspect-square rounded-lg bg-muted/30 border flex items-center justify-center overflow-hidden relative cursor-move touch-none",
                    gridTheme === "light"
                      ? "checkerboard-light"
                      : "checkerboard-dark",
                  )}
                  onMouseDown={() => setIsPanningSheet(true)}
                  onMouseMove={(e) => {
                    if (!isPanningSheet) return;
                    setSheetPan((prev) => ({
                      x: prev.x + e.movementX / sheetZoom,
                      y: prev.y + e.movementY / sheetZoom,
                    }));
                  }}
                  onMouseUp={() => setIsPanningSheet(false)}
                  onMouseLeave={() => setIsPanningSheet(false)}
                  onWheel={(e) => handleWheel(e, "sheet")}
                  onTouchMove={(e) => handleTouchMove(e, "sheet")}
                  onTouchEnd={handleTouchEnd}
                >
                  {spritesheetUrl ? (
                    <img
                      src={spritesheetUrl}
                      alt="Result"
                      className="object-contain transition-transform duration-200"
                      style={{
                        transform: `scale(${sheetZoom}) translate(${sheetPan.x}px, ${sheetPan.y}px)`,
                      }}
                      draggable={false}
                    />
                  ) : (
                    <div className="text-center p-6 space-y-4">
                      <p className="text-muted-foreground text-sm">
                        No sheet compiled yet.
                      </p>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="gap-2"
                        onClick={generateSpritesheet}
                        disabled={processedFrames.length === 0}
                      >
                        <RefreshCw className="w-4 h-4" />
                        Compile Selection
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px]">Columns</Label>
                    <Input
                      type="number"
                      className="h-7 w-12 text-xs"
                      value={columns}
                      onChange={(e) => setColumns(Number(e.target.value))}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    Zoom: {Math.round(sheetZoom * 100)}%
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>
                  Frame Selection ({selectedIndices.size} /{" "}
                  {processedFrames.length})
                </CardTitle>
                <CardDescription>
                  Drag to toggle multiple frames.
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-[10px]"
                  onClick={() => setSelectedIndices(new Set())}
                >
                  Deselect All
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-[10px]"
                  onClick={() =>
                    setSelectedIndices(
                      new Set(processedFrames.map((_, i) => i)),
                    )
                  }
                >
                  Select All
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {processedFrames.length > 0 ? (
                <div
                  className={cn(
                    "grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-[350px] overflow-y-auto p-1 border rounded-md select-none",
                    gridTheme === "light"
                      ? "checkerboard-light"
                      : "checkerboard-dark",
                  )}
                >
                  {processedFrames.map((frame, i) => (
                    <div
                      key={i}
                      className={cn(
                        "aspect-square border rounded bg-muted/50 overflow-hidden group relative cursor-pointer transition-all",
                        selectedIndices.has(i)
                          ? "ring-2 ring-primary"
                          : "opacity-40 grayscale",
                        activeFrames[previewIndex] === processedFrames[i] &&
                          "ring-offset-2 ring-2 ring-blue-500",
                      )}
                      onMouseDown={() => handleFrameMouseDown(i)}
                      onMouseEnter={() => handleFrameMouseEnter(i)}
                    >
                      <img
                        src={frame}
                        alt={`F${i}`}
                        className="w-full h-full object-contain pointer-events-none"
                      />
                      <div className="absolute top-1 right-1">
                        {selectedIndices.has(i) ? (
                          <CheckCircle2 className="w-3 h-3 text-primary bg-white rounded-full" />
                        ) : (
                          <Circle className="w-3 h-3 text-muted-foreground bg-white/50 rounded-full" />
                        )}
                      </div>
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="text-[10px] text-white font-mono">
                          #{i}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 border-2 border-dashed rounded-lg border-muted-foreground/10 bg-muted/5">
                  <ImageIcon className="w-12 h-12 text-muted-foreground/20 mx-auto mb-4" />
                  <p className="text-muted-foreground text-sm">
                    No frames extracted.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
