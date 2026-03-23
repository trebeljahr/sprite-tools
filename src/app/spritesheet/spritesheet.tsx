"use client";

import confetti from "canvas-confetti";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  ImageIcon,
  Loader2,
  Maximize,
  Palette,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { BackgroundRemovalSettings, type BackgroundRemovalState, type AspectRatio } from "@/components/background-removal-settings";
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
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { applyChromaKey, cn } from "@/lib/utils";

// Memoized Frame Item for Performance
const FrameItem = React.memo(
  ({
    index,
    frame,
    isSelected,
    isActive,
    gridTheme,
    onMouseDown,
    onMouseEnter,
  }: {
    index: number;
    frame: string;
    isSelected: boolean;
    isActive: boolean;
    gridTheme: "light" | "dark";
    onMouseDown: (index: number) => void;
    onMouseEnter: (index: number) => void;
  }) => {
    return (
      <div
        className={cn(
          "aspect-square border rounded overflow-hidden group relative cursor-pointer transition-all",
          gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
          isSelected ? "ring-2 ring-primary" : "opacity-40 grayscale",
          isActive && "ring-offset-2 ring-2 ring-blue-500",
        )}
        onMouseDown={() => onMouseDown(index)}
        onMouseEnter={() => onMouseEnter(index)}
      >
        <img
          src={frame}
          alt={`F${index}`}
          className="w-full h-full object-contain pointer-events-none"
        />
        <div className="absolute top-1 right-1">
          {isSelected ? (
            <CheckCircle2 className="w-3 h-3 text-primary bg-white rounded-full" />
          ) : (
            <Circle className="w-3 h-3 text-muted-foreground bg-white/50 rounded-full" />
          )}
        </div>
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="text-xs text-white font-mono">#{index}</span>
        </div>
      </div>
    );
  },
);

FrameItem.displayName = "FrameItem";

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
  const [isCompiling, setIsCompiling] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [progress, setProgress] = useState(0);
  const [smoothProgress, setSmoothProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [actionOrigin, setActionOrigin] = useState<
    "extract" | "settings" | null
  >(null);

  const [fps, setFps] = useState(10);
  const [columns, setColumns] = useState(8);
  const [spritesheetUrl, setSpritesheetUrl] = useState<string | null>(null);

  // Background Removal Settings
  const [brState, setBrState] = useState<BackgroundRemovalState>({
    backgroundMode: "chroma-transparent",
    autoCrop: true,
    aspectRatio: "free",
    solidColor: "#ffffff",
    autoDetermineFillColor: true,
    similarity: 30,
    softness: 10,
    spill: 20,
    choke: 1,
  });

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

  const activeIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < processedFrames.length; i++) {
      if (selectedIndices.size === 0 || selectedIndices.has(i)) {
        indices.push(i);
      }
    }
    return indices;
  }, [processedFrames.length, selectedIndices]);

  const activeFrames = useMemo(() => {
    return activeIndices.map((i) => processedFrames[i]);
  }, [activeIndices, processedFrames]);

  const currentGlobalIndex = activeIndices[previewIndex] ?? -1;

  const previewContainerRef = useRef<HTMLDivElement>(null);
  const sheetContainerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Synchronous State Adjustments (Render Phase)
  if (progress === 0 && smoothProgress !== 0) {
    setSmoothProgress(0);
  }
  if (activeFrames.length > 0 && previewIndex >= activeFrames.length) {
    setPreviewIndex(0);
  }

  // Progress Smoothing (Lerp)
  useEffect(() => {
    if (smoothProgress < progress) {
      const timeout = setTimeout(() => {
        setSmoothProgress((prev) => Math.min(progress, prev + 1));
      }, 20);
      return () => clearTimeout(timeout);
    }
  }, [progress, smoothProgress]);

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
      setShowResults(false);
      setPreviewIndex(0);
      setIsPlaying(false);
      setProgress(0);
    }
  };

  const extractFrames = async () => {
    if (!videoUrl) return;
    setIsExtracting(true);
    setActionOrigin("extract");
    setProgressLabel("Extracting Video...");
    setProgress(0);
    setRawFrames([]);
    setProcessedFrames([]);
    setSpritesheetUrl(null);
    setShowResults(false);
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
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (blob) extracted.push(URL.createObjectURL(blob));
      }
      setProgress(Math.round(((i + 1) / totalFramesCount) * 50));
    }

    setRawFrames(extracted);
    setSelectedIndices(new Set(extracted.map((_, i) => i)));
    const processed = await processFrames(extracted, true);

    if (processed && processed.length > 0) {
      await generateSpritesheet(processed);
    }

    setIsExtracting(false);
    toast.success(`Extracted and processed ${extracted.length} frames!`);
    await new Promise((r) => setTimeout(r, 200));
    setShowResults(true);
    setTimeout(() => {
      resultsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
    setActionOrigin(null);
    await new Promise((r) => setTimeout(r, 500));
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.9 },
      colors: ["#4ade80", "#22c55e", "#3b82f6", "#f59e0b"],
    });
  };

  const processFrames = async (
    sourceFrames = rawFrames,
    isInitial = false,
  ): Promise<string[]> => {
    if (sourceFrames.length === 0) return [];

    setIsProcessing(true);
    if (!isInitial) {
      setActionOrigin("settings");
      setProgress(0);
    }

    setProgressLabel("Removing background...");
    processedFrames.forEach((url) => URL.revokeObjectURL(url));

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    let fw = 0,
      fh = 0;
    if (sourceFrames.length > 0) {
      const img = new Image();
      img.src = sourceFrames[0];
      await new Promise((resolve) => (img.onload = resolve));
      fw = img.width;
      fh = img.height;
      canvas.width = fw;
      canvas.height = fh;
    }

    const frameImageData: ImageData[] = [];
    let globalMinX = fw,
      globalMinY = fh,
      globalMaxX = 0,
      globalMaxY = 0;
    let foundAnyContent = false;

    for (let i = 0; i < sourceFrames.length; i++) {
      const frameImg = new Image();
      frameImg.src = sourceFrames[i];
      await new Promise((resolve) => (frameImg.onload = resolve));

      if (ctx) {
        ctx.clearRect(0, 0, fw, fh);
        ctx.drawImage(frameImg, 0, 0);

        const isChroma = brState.backgroundMode !== "transparent-cutout";

        if (isChroma) {
          const imageData = ctx.getImageData(0, 0, fw, fh);
          const data = imageData.data;

          const corners = [
            { r: data[0], g: data[1], b: data[2] },
            {
              r: data[(fw - 1) * 4],
              g: data[(fw - 1) * 4 + 1],
              b: data[(fw - 1) * 4 + 2],
            },
            {
              r: data[data.length - fw * 4],
              g: data[data.length - fw * 4 + 1],
              b: data[data.length - fw * 4 + 2],
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

          applyChromaKey(ctx, fw, fh, target, brState);
          const processedData = ctx.getImageData(0, 0, fw, fh);

          if (brState.autoCrop) {
            const d = processedData.data;
            for (let y = 0; y < fh; y++) {
              for (let x = 0; x < fw; x++) {
                if (d[(y * fw + x) * 4 + 3] > 0) {
                  if (x < globalMinX) globalMinX = x;
                  if (y < globalMinY) globalMinY = y;
                  if (x > globalMaxX) globalMaxX = x;
                  if (y > globalMaxY) globalMaxY = y;
                  foundAnyContent = true;
                }
              }
            }
          }
          frameImageData.push(processedData);
        } else {
          const imageData = ctx.getImageData(0, 0, fw, fh);
          frameImageData.push(imageData);
        }
      }

      const step1Progress = Math.round(((i + 1) / sourceFrames.length) * 70);
      setProgress(
        isInitial ? 50 + Math.round(step1Progress * 0.5) : step1Progress,
      );
    }

    setProgressLabel("Auto-Cropping...");
    const processed: string[] = [];
    const padding = 2;
    let cropX = 0,
      cropY = 0,
      cropW = fw,
      cropH = fh;

    if (brState.backgroundMode !== "transparent-cutout" && brState.autoCrop && foundAnyContent) {
      cropX = Math.max(0, globalMinX - padding);
      cropY = Math.max(0, globalMinY - padding);
      cropW = Math.min(fw - cropX, globalMaxX - globalMinX + 1 + padding * 2);
      cropH = Math.min(fh - cropY, globalMaxY - globalMinY + 1 + padding * 2);
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = cropW;
    outputCanvas.height = cropH;
    const octx = outputCanvas.getContext("2d");

    for (let i = 0; i < frameImageData.length; i++) {
      if (octx) {
        octx.clearRect(0, 0, cropW, cropH);
        octx.putImageData(frameImageData[i], -cropX, -cropY);
        const blob = await new Promise<Blob | null>((resolve) =>
          outputCanvas.toBlob(resolve, "image/png"),
        );
        if (blob) processed.push(URL.createObjectURL(blob));
      }
      const step2Progress = Math.round(((i + 1) / frameImageData.length) * 30);
      const currentProcessingProgress = 70 + step2Progress;
      setProgress(
        isInitial
          ? 50 + Math.round(currentProcessingProgress * 0.5)
          : currentProcessingProgress,
      );
    }

    setProcessedFrames(processed);
    setIsProcessing(false);
    if (!isInitial) {
      toast.success("Frames processed!");
      setActionOrigin(null);
    }
    return processed;
  };

  const generateSpritesheet = async (framesOverride?: string[]) => {
    const framesToUse =
      framesOverride ||
      processedFrames.filter((_, i) => selectedIndices.has(i));
    if (framesToUse.length === 0) {
      setSpritesheetUrl(null);
      return;
    }
    setIsCompiling(true);
    if (spritesheetUrl) URL.revokeObjectURL(spritesheetUrl);
    try {
      const img = new Image();
      img.src = framesToUse[0];
      await new Promise((resolve) => (img.onload = resolve));
      const fw = img.width,
        fh = img.height;
      const rows = Math.ceil(framesToUse.length / columns);
      const canvas = document.createElement("canvas");
      canvas.width = columns * fw;
      canvas.height = rows * fh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      for (let i = 0; i < framesToUse.length; i++) {
        const fImg = new Image();
        fImg.src = framesToUse[i];
        await new Promise((resolve) => (fImg.onload = resolve));
        ctx.drawImage(fImg, (i % columns) * fw, Math.floor(i / columns) * fh);
      }
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob) setSpritesheetUrl(URL.createObjectURL(blob));
    } finally {
      setIsCompiling(false);
    }
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
                  disabled={isExtracting || isProcessing || !videoUrl}
                  className="w-full"
                >
                  {isExtracting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Scissors className="mr-2 h-4 w-4" />
                  )}
                  {isExtracting
                    ? isProcessing
                      ? "Processing..."
                      : "Extracting..."
                    : "Extract Raw Frames"}
                </Button>
                {actionOrigin === "extract" &&
                  (isExtracting || isProcessing) && (
                    <div className="space-y-2 pt-2">
                      <div className="flex justify-between text-xs font-medium uppercase tracking-wider">
                        {smoothProgress === 100 ? (
                          <span className="text-primary animate-pulse font-bold">
                            Finishing up...
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {progressLabel}
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
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <BackgroundRemovalSettings
                state={brState}
                setState={setBrState}
                mode="chroma-only"
              />

              {showResults && (
                <div className="space-y-4 border-t border-dashed pt-4">
                  <Button
                    onClick={async () => {
                      const processed = await processFrames();
                      if (processed && processed.length > 0) {
                        await generateSpritesheet(processed);
                      }
                    }}
                    disabled={
                      isProcessing || isExtracting || rawFrames.length === 0
                    }
                    variant="outline"
                    className="w-full"
                  >
                    {isProcessing && actionOrigin === "settings" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4 text-primary" />
                    )}
                    Re-do Background Removal
                  </Button>

                  {isProcessing && actionOrigin === "settings" && (
                    <div className="space-y-2 pt-2">
                      <div className="flex justify-between text-xs font-medium uppercase tracking-wider">
                        {smoothProgress === 100 ? (
                          <span className="text-primary animate-pulse font-bold">
                            Finishing up...
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {progressLabel}
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
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {showResults && (
            <div
              ref={resultsRef}
              className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700 scroll-mt-12"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card className="md:col-span-1 shadow-lg ring-1 ring-primary/10">
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">Preview</CardTitle>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Toggle Background Grid Color"
                        onClick={() =>
                          setGridTheme((prev) =>
                            prev === "light" ? "dark" : "light",
                          )
                        }
                      >
                        <Palette
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
                        onClick={() =>
                          setZoom((prev) => Math.max(0.5, prev - 0.2))
                        }
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
                        onClick={() =>
                          setZoom((prev) => Math.min(5, prev + 0.2))
                        }
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
                          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
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
                    "md:col-span-1 shadow-lg ring-1 ring-primary/5",
                    processedFrames.length === 0 && "opacity-50",
                  )}
                >
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-lg">Sprite Sheet</CardTitle>
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
                        className="h-7 text-xs gap-1 px-2"
                        onClick={() => generateSpritesheet()}
                        disabled={processedFrames.length === 0 || isCompiling}
                      >
                        {isCompiling ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3 h-3" />
                        )}
                        {isCompiling ? "Compiling..." : "Compile"}
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
                        <div className="text-center p-6 space-y-4 opacity-20">
                          <ImageIcon className="w-12 h-12 mx-auto mb-2" />
                          <p className="text-sm font-medium">
                            Spritesheet will appear here
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Columns</Label>
                        <Input
                          type="number"
                          className="h-7 w-12 text-xs"
                          value={columns}
                          onChange={(e) => setColumns(Number(e.target.value))}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        Zoom: {Math.round(sheetZoom * 100)}%
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-lg ring-1 ring-primary/5">
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
                      className="h-8 text-xs"
                      onClick={() => setSelectedIndices(new Set())}
                    >
                      Deselect All
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
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
                  <div
                    className={cn(
                      "grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-87.5 overflow-y-auto p-1 border rounded-md select-none",
                    )}
                  >
                    {processedFrames.map((frame, i) => (
                      <FrameItem
                        key={i}
                        index={i}
                        frame={frame}
                        isSelected={selectedIndices.has(i)}
                        isActive={currentGlobalIndex === i}
                        gridTheme={gridTheme}
                        onMouseDown={handleFrameMouseDown}
                        onMouseEnter={handleFrameMouseEnter}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
