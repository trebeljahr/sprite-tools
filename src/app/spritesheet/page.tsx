"use client";

import * as React from "react";
import { useState, useRef, useEffect, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import confetti from "canvas-confetti";
import {
  Upload,
  Scissors,
  Download,
  Loader2,
  Play,
  Pause,
  RefreshCw,
  ImageIcon,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Palette,
  Check,
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
import { Progress } from "@/components/ui/progress";
import { cn, applyChromaKey, applySolidFillChroma, hexToRgb, sampleBackground } from "@/lib/utils";
import { BackgroundRemovalSettings, type BackgroundRemovalState, type AspectRatio } from "@/components/background-removal-settings";
import { useViewport } from "@/hooks/use-viewport";
import {
  ViewportControls,
  ZoomIndicator,
} from "@/components/viewport-controls";

// Memoized Frame Item for Performance
const FrameItem = React.memo(function SingleFrameItem({
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
}) {
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
          <div className="w-4 h-4 bg-primary rounded shadow-sm border border-primary-foreground/20 flex items-center justify-center">
            <Check
              className="w-3 h-3 text-primary-foreground"
              strokeWidth={3}
            />
          </div>
        ) : (
          <div className="w-4 h-4 bg-black/20 backdrop-blur-sm rounded border border-white/30" />
        )}
      </div>
      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-xs text-white font-mono">#{index}</span>
      </div>
    </div>
  );
});

// Helper to calculate a balanced grid (columns closest to square root)
const calculateSmartColumns = (count: number) => {
  if (count <= 1) return 1;
  const sqrt = Math.sqrt(count);
  return Math.ceil(sqrt);
};

function SpritesheetContent() {
  const searchParams = useSearchParams();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  // ... (existing state)

  useEffect(() => {
    const url = searchParams.get("videoUrl");
    if (url) {
      setVideoUrl(url);
      toast.success("Animation loaded from Step 2!");
    }
  }, [searchParams]);

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

  // Shared Viewport Hooks
  const previewViewport = useViewport();
  const { view: pView } = previewViewport;

  const sheetViewport = useViewport();
  const { view: sView } = sheetViewport;

  const hasAutoFittedPreview = useRef(false);
  const hasAutoFittedSheet = useRef(false);
  const frameDimensions = useRef({ w: 0, h: 0 });
  const sheetDimensions = useRef({ w: 0, h: 0 });

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

  // Animation Playback State
  const [previewIndex, setPreviewIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackRef = useRef<NodeJS.Timeout | null>(null);

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

  const previewContainerRef = previewViewport.containerRef;
  const sheetContainerRef = sheetViewport.containerRef;
  const resultsRef = useRef<HTMLDivElement>(null);

  // Auto-fit animation preview when frames are processed or selection changes (only once)
  useEffect(() => {
    if (
      processedFrames.length > 0 &&
      frameDimensions.current.w > 0 &&
      previewViewport.containerRef.current &&
      !hasAutoFittedPreview.current
    ) {
      const raf = requestAnimationFrame(() => {
        previewViewport.fitToView(
          frameDimensions.current.w,
          frameDimensions.current.h,
        );
        hasAutoFittedPreview.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [processedFrames, activeFrames.length, previewViewport]);

  // Auto-fit spritesheet when generated (only once)
  useEffect(() => {
    if (
      spritesheetUrl &&
      sheetDimensions.current.w > 0 &&
      sheetViewport.containerRef.current &&
      !hasAutoFittedSheet.current
    ) {
      const raf = requestAnimationFrame(() => {
        sheetViewport.fitToView(
          sheetDimensions.current.w,
          sheetDimensions.current.h,
        );
        hasAutoFittedSheet.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [spritesheetUrl, sheetViewport]);

  // Progress Smoothing
  useEffect(() => {
    if (smoothProgress < progress) {
      const timeout = setTimeout(() => {
        setSmoothProgress((prev) => Math.min(progress, prev + 1));
      }, 20);
      return () => clearTimeout(timeout);
    }
  }, [progress, smoothProgress]);

  // Synchronous State Adjustments
  if (progress === 0 && smoothProgress !== 0) setSmoothProgress(0);
  if (activeFrames.length > 0 && previewIndex >= activeFrames.length)
    setPreviewIndex(0);

  // Mouse Wheel Zoom Handlers
  useEffect(() => {
    const preview = previewContainerRef.current;
    const sheet = sheetContainerRef.current;
    const onPreviewWheel = (e: WheelEvent) => {
      e.preventDefault();
      previewViewport.handleWheel(e, preview);
    };
    const onSheetWheel = (e: WheelEvent) => {
      e.preventDefault();
      sheetViewport.handleWheel(e, sheet);
    };
    const preventDefault = (e: Event) => e.preventDefault();

    if (preview) {
      preview.addEventListener("wheel", onPreviewWheel, { passive: false });
      preview.addEventListener("gesturestart", preventDefault, {
        passive: false,
      });
    }
    if (sheet) {
      sheet.addEventListener("wheel", onSheetWheel, { passive: false });
      sheet.addEventListener("gesturestart", preventDefault, {
        passive: false,
      });
    }
    return () => {
      if (preview) preview.removeEventListener("wheel", onPreviewWheel);
      if (sheet) sheet.removeEventListener("wheel", onSheetWheel);
    };
  }, [previewViewport, sheetViewport, previewContainerRef, sheetContainerRef]);

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
      setVideoUrl(URL.createObjectURL(file));
      setRawFrames([]);
      setProcessedFrames([]);
      setSpritesheetUrl(null);
      setShowResults(false);
      setPreviewIndex(0);
      setIsPlaying(false);
      setProgress(0);
      hasAutoFittedPreview.current = false;
      hasAutoFittedSheet.current = false;
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

    // Determine smart default columns
    const smartCols = calculateSmartColumns(extracted.length);
    setColumns(smartCols);

    const processed = await processFrames(extracted, true);
    if (processed && processed.length > 0)
      await generateSpritesheet(processed, smartCols);

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

    const fillWithVerticalGradient = (
      ictx: CanvasRenderingContext2D,
      w: number,
      h: number,
      colors: { tl: {r:number,g:number,b:number}, tr: {r:number,g:number,b:number}, bl: {r:number,g:number,b:number}, br: {r:number,g:number,b:number} }
    ) => {
      const grad = ictx.createLinearGradient(0, 0, 0, h);
      const topR = Math.round((colors.tl.r + colors.tr.r) / 2);
      const topG = Math.round((colors.tl.g + colors.tr.g) / 2);
      const topB = Math.round((colors.tl.b + colors.tr.b) / 2);
      const botR = Math.round((colors.bl.r + colors.br.r) / 2);
      const botG = Math.round((colors.bl.g + colors.br.g) / 2);
      const botB = Math.round((colors.bl.b + colors.br.b) / 2);
      grad.addColorStop(0, `rgb(${topR}, ${topG}, ${topB})`);
      grad.addColorStop(1, `rgb(${botR}, ${botG}, ${botB})`);
      ictx.fillStyle = grad;
      ictx.fillRect(0, 0, w, h);
    };

    const targetSolidRgb = hexToRgb(brState.solidColor);

    for (let i = 0; i < sourceFrames.length; i++) {
      const frameImg = new Image();
      frameImg.src = sourceFrames[i];
      await new Promise((resolve) => (frameImg.onload = resolve));

      if (ctx) {
        ctx.clearRect(0, 0, fw, fh);
        ctx.drawImage(frameImg, 0, 0);

        const isChroma = brState.backgroundMode !== "transparent-cutout";
        const isSolid = brState.backgroundMode === "chroma-solid";
        
        const sampled = sampleBackground(frameImg);
        const detectedBackground = { r: sampled.r, g: sampled.g, b: sampled.b };

        if (isChroma) {
          if (isSolid) {
            // SPATIAL FEATHERING for Solid Fill with Vertical Gradient
            const finalTarget = brState.autoDetermineFillColor ? sampled.corners : {
              tl: targetSolidRgb, tr: targetSolidRgb, bl: targetSolidRgb, br: targetSolidRgb
            };
            
            // 1. Create a binary mask
            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = fw;
            maskCanvas.height = fh;
            const mctx = maskCanvas.getContext("2d");
            if (mctx) {
              const imageData = ctx.getImageData(0, 0, fw, fh);
              const data = imageData.data;
              const { similarity } = brState;
              
              for (let j = 0; j < data.length; j += 4) {
                const dist = Math.sqrt(
                  Math.pow(data[j] - detectedBackground.r, 2) + 
                  Math.pow(data[j+1] - detectedBackground.g, 2) + 
                  Math.pow(data[j+2] - detectedBackground.b, 2)
                );
                const isBg = dist < similarity;
                data[j] = data[j+1] = data[j+2] = isBg ? 0 : 255;
                data[j+3] = 255;
              }
              mctx.putImageData(imageData, 0, 0);

              // 2. Clear main canvas and fill with gradient/solid
              fillWithVerticalGradient(ctx, fw, fh, finalTarget);

              // 3. Draw feathered character
              const tempCanvas = document.createElement("canvas");
              tempCanvas.width = fw;
              tempCanvas.height = fh;
              const tctx = tempCanvas.getContext("2d");
              if (tctx) {
                const cleanCharCanvas = document.createElement("canvas");
                cleanCharCanvas.width = fw;
                cleanCharCanvas.height = fh;
                const ccctx = cleanCharCanvas.getContext("2d");
                if (ccctx) {
                   fillWithVerticalGradient(ccctx, fw, fh, finalTarget);
                   const hardCharOnlyCanvas = document.createElement("canvas");
                   hardCharOnlyCanvas.width = fw;
                   hardCharOnlyCanvas.height = fh;
                   const hcoctx = hardCharOnlyCanvas.getContext("2d");
                   if (hcoctx) {
                     hcoctx.drawImage(frameImg, 0, 0);
                     hcoctx.globalCompositeOperation = "destination-in";
                     hcoctx.drawImage(maskCanvas, 0, 0);
                     ccctx.drawImage(hardCharOnlyCanvas, 0, 0);
                   }
                   tctx.drawImage(cleanCharCanvas, 0, 0);
                   tctx.globalCompositeOperation = "destination-in";
                   if (brState.softness > 0) tctx.filter = `blur(${brState.softness}px)`;
                   tctx.drawImage(maskCanvas, 0, 0);
                   ctx.drawImage(tempCanvas, 0, 0);
                }
              }
            }
          } else {
            applyChromaKey(ctx, fw, fh, detectedBackground, brState);
          }
        }

        const processedData = ctx.getImageData(0, 0, fw, fh);
        const d = processedData.data;

        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const idx = (y * fw + x) * 4;
            let isContent = false;
            if (isSolid) {
              const dist = Math.sqrt(
                Math.pow(d[idx]-detectedBackground.r,2) + 
                Math.pow(d[idx+1]-detectedBackground.g,2) + 
                Math.pow(d[idx+2]-detectedBackground.b,2)
              );
              if (dist > brState.similarity) isContent = true;
            } else if (d[idx + 3] > 0) {
              isContent = true;
            }

            if (isContent) {
              if (x < globalMinX) globalMinX = x;
              if (y < globalMinY) globalMinY = y;
              if (x > globalMaxX) globalMaxX = x;
              if (y > globalMaxY) globalMaxY = y;
              foundAnyContent = true;
            }
          }
        }
        frameImageData.push(processedData);
      }
      const step1Progress = Math.round(((i + 1) / sourceFrames.length) * 70);
      setProgress(
        isInitial ? 50 + Math.round(step1Progress * 0.5) : step1Progress,
      );
    }

    setProgressLabel("Finalizing output...");
    const processed: string[] = [];
    const padding = 2;
    let cropX = 0,
      cropY = 0,
      cropW = fw,
      cropH = fh;

    if (brState.autoCrop && foundAnyContent) {
      cropX = Math.max(0, globalMinX - padding);
      cropY = Math.max(0, globalMinY - padding);
      cropW = Math.min(fw - cropX, globalMaxX - globalMinX + 1 + padding * 2);
      cropH = Math.min(fh - cropY, globalMaxY - globalMinY + 1 + padding * 2);
      
      // Handle Aspect Ratio
      if (brState.aspectRatio !== "free") {
        const [rw, rh] = brState.aspectRatio.split(":").map(Number);
        const targetRatio = rw / rh;
        const currentRatio = cropW / cropH;
        
        let finalW = cropW;
        let finalH = cropH;
        
        if (currentRatio > targetRatio) {
          // Content is wider than target ratio, expand height
          finalH = cropW / targetRatio;
        } else {
          // Content is taller than target ratio, expand width
          finalW = cropH * targetRatio;
        }
        
        // Center the original crop within the new aspect ratio crop
        const dx = (finalW - cropW) / 2;
        const dy = (finalH - cropH) / 2;
        
        cropX -= dx;
        cropY -= dy;
        cropW = finalW;
        cropH = finalH;
      }
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = Math.round(cropW);
    outputCanvas.height = Math.round(cropH);
    const octx = outputCanvas.getContext("2d");

    for (let i = 0; i < frameImageData.length; i++) {
      if (octx) {
        octx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        
        if (brState.backgroundMode === "chroma-solid") {
          let fillColor = brState.solidColor;
          if (brState.autoDetermineFillColor) {
            const d = frameImageData[i].data;
            // The background pixel (0,0) of the processed data in solid mode
            // already has the determined color
            fillColor = `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
          }
          octx.fillStyle = fillColor;
          octx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
        }
        
        octx.putImageData(frameImageData[i], -Math.round(cropX), -Math.round(cropY));
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
    frameDimensions.current = { w: cropW, h: cropH };
    hasAutoFittedPreview.current = false;

    setIsProcessing(false);
    if (!isInitial) {
      toast.success("Frames processed!");
      setActionOrigin(null);
    }
    return processed;
  };

  const generateSpritesheet = async (
    framesOverride?: string[],
    columnsOverride?: number,
  ) => {
    const framesToUse =
      framesOverride ||
      processedFrames.filter((_, i) => selectedIndices.has(i));
    if (framesToUse.length === 0) {
      setSpritesheetUrl(null);
      return;
    }
    const cols = columnsOverride || columns;
    setIsCompiling(true);
    if (spritesheetUrl) URL.revokeObjectURL(spritesheetUrl);
    try {
      const img = new Image();
      img.src = framesToUse[0];
      await new Promise((resolve) => (img.onload = resolve));
      const fw = img.width,
        fh = img.height;
      const rows = Math.ceil(framesToUse.length / cols);
      const canvas = document.createElement("canvas");
      canvas.width = cols * fw;
      canvas.height = rows * fh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      for (let i = 0; i < framesToUse.length; i++) {
        const fImg = new Image();
        fImg.src = framesToUse[i];
        await new Promise((resolve) => (fImg.onload = resolve));
        ctx.drawImage(fImg, (i % cols) * fw, Math.floor(i / cols) * fh);
      }
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob) {
        const url = URL.createObjectURL(blob);
        setSpritesheetUrl(url);
        sheetDimensions.current = { w: canvas.width, h: canvas.height };
        hasAutoFittedSheet.current = false;
      }
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

  const downloadSpritesheet = () => {
    if (!spritesheetUrl) return;
    const link = document.createElement("a");
    link.href = spritesheetUrl;
    link.download = "spritesheet.png";
    link.click();
  };

  return (
    <main className="flex-1 container max-w-7xl mx-auto py-8 px-4">
      {/* Pipeline Progress */}
      <div className="flex items-center justify-center mb-12 space-x-4">
        <Link href="/generate" className="flex items-center text-muted-foreground hover:text-primary transition-colors">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold">1</div>
          <span className="ml-2 font-medium">Design</span>
        </Link>
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
        <Link href="/" className="flex items-center text-muted-foreground hover:text-primary transition-colors">
          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold">2</div>
          <span className="ml-2 font-medium">Animate</span>
        </Link>
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
        <div className="flex items-center text-primary">
          <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold">3</div>
          <span className="ml-2 font-medium">Extract</span>
        </div>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Advanced Sprite Tools
        </h1>
        <p className="text-muted-foreground">
          Step 3: Extract, filter, and stitch animation sheets.
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
                      if (processed && processed.length > 0)
                        await generateSpritesheet(processed);
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
                    <ViewportControls
                      onZoomIn={() =>
                        frameDimensions.current.w > 0 &&
                        previewViewport.setZoomIn(
                          frameDimensions.current.w,
                          frameDimensions.current.h,
                        )
                      }
                      onZoomOut={() =>
                        frameDimensions.current.w > 0 &&
                        previewViewport.setZoomOut(
                          frameDimensions.current.w,
                          frameDimensions.current.h,
                        )
                      }
                      onReset={() =>
                        previewViewport.fitToView(
                          frameDimensions.current.w,
                          frameDimensions.current.h,
                        )
                      }
                    />
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div
                      ref={previewContainerRef}
                      className={cn(
                        "aspect-square rounded-lg border overflow-hidden relative cursor-move touch-none",
                        gridTheme === "light"
                          ? "checkerboard-light"
                          : "checkerboard-dark",
                      )}
                      onMouseDown={previewViewport.startPanning}
                      onMouseMove={previewViewport.updatePanning}
                      onMouseUp={previewViewport.stopPanning}
                      onMouseLeave={previewViewport.stopPanning}
                    >
                      {activeFrames.length > 0 ? (
                        <>
                          <img
                            src={activeFrames[previewIndex]}
                            alt="Preview"
                            className="absolute top-0 left-0 max-w-none"
                            style={{
                              transform: `translate(${pView.offset.x}px, ${pView.offset.y}px) scale(${pView.zoom})`,
                              transformOrigin: "0 0",
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
                          <ZoomIndicator
                            zoom={pView.zoom}
                            baseZoom={previewViewport.baseView.zoom}
                            className="absolute bottom-2 right-2"
                          />
                        </>
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
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
                    "md:col-span-1 shadow-lg ring-1 ring-primary/10",
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
                    <div className="flex gap-1 items-center">
                      <ViewportControls
                        onZoomIn={() =>
                          sheetDimensions.current.w > 0 &&
                          sheetViewport.setZoomIn(
                            sheetDimensions.current.w,
                            sheetDimensions.current.h,
                          )
                        }
                        onZoomOut={() =>
                          sheetDimensions.current.w > 0 &&
                          sheetViewport.setZoomOut(
                            sheetDimensions.current.w,
                            sheetDimensions.current.h,
                          )
                        }
                        onReset={() =>
                          sheetViewport.fitToView(
                            sheetDimensions.current.w,
                            sheetDimensions.current.h,
                          )
                        }
                      />
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
                        "aspect-square rounded-lg border overflow-hidden relative cursor-move touch-none",
                        gridTheme === "light"
                          ? "checkerboard-light"
                          : "checkerboard-dark",
                      )}
                      onMouseDown={sheetViewport.startPanning}
                      onMouseMove={sheetViewport.updatePanning}
                      onMouseUp={sheetViewport.stopPanning}
                      onMouseLeave={sheetViewport.stopPanning}
                    >
                      {spritesheetUrl ? (
                        <img
                          src={spritesheetUrl}
                          alt="Result"
                          className="absolute top-0 left-0 max-w-none"
                          style={{
                            transform: `translate(${sView.offset.x}px, ${sView.offset.y}px) scale(${sView.zoom})`,
                            transformOrigin: "0 0",
                          }}
                          draggable={false}
                        />
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 opacity-20">
                          <ImageIcon className="w-12 h-12" />
                          <p className="text-sm font-medium">
                            Spritesheet will appear here
                          </p>
                        </div>
                      )}
                      <ZoomIndicator
                        zoom={sView.zoom}
                        baseZoom={sheetViewport.baseView.zoom}
                        className="absolute bottom-2 right-2"
                      />
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
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-lg ring-1 ring-primary/10">
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

export default function SpritesheetPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen text-muted-foreground"><Loader2 className="w-8 h-8 animate-spin mr-2" /> Loading Step 3...</div>}>
      <SpritesheetContent />
    </Suspense>
  );
}
