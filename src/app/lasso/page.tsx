"use client";

import {
  BackgroundRemovalSettings,
  type BackgroundRemovalState,
} from "@/components/background-removal-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { useViewport } from "@/hooks/use-viewport";
import { cn, applyChromaKey, applySolidFillChroma, sampleBackground } from "@/lib/utils";

import confetti from "canvas-confetti";
import {
  Download,
  Palette,
  RefreshCw,
  Scissors,
  Sparkles,
  Trash2,
  Undo,
  Upload,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface Point {
  x: number;
  y: number;
}

export default function LassoPage() {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastClickTime, setLastClickTime] = useState(0);

  // View State using shared hook
  const canvasViewport = useViewport();
  const {
    view,
    isPanning,
    containerRef: canvasContainerRef,
    baseView,
    setZoomIn,
    setZoomOut,
    fitToView,
  } = canvasViewport;

  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [draggedPointIndex, setDraggedPointIndex] = useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  // Track movement during mouse down to differentiate click vs drag
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const hasDragged = useRef(false);

  // Preview View State using shared hook
  const previewViewport = useViewport();
  const {
    view: pView,
    containerRef: previewContainerRef,
    baseView: pBaseView,
    setZoomIn: pSetZoomIn,
    setZoomOut: pSetZoomOut,
    fitToView: pFitToView,
  } = previewViewport;

  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const previewDimensions = useRef({ w: 0, h: 0 });

  // Background Removal Settings
  const [brState, setBrState] = useState<BackgroundRemovalState>({
    backgroundMode: "chroma-solid",
    autoCrop: true,
    aspectRatio: "1:1",
    similarity: 30,
    softness: 10,
    spill: 20,
    choke: 1,
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const hasAutoFittedMain = useRef(false);
  const hasAutoFittedPreview = useRef(false);
  const localCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLImageElement | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Unsupported file type. Please upload an image.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        setImage(img);
        setPoints([]);
        setIsClosed(false);
        setPreviewUrl(null);
        hasAutoFittedMain.current = false;
        hasAutoFittedPreview.current = false;
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // Global Paste Support
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) handleFile(file);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [handleFile]);

  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // Auto-fit main image when it loads or container becomes available
  useEffect(() => {
    if (image && canvasContainerRef.current && !hasAutoFittedMain.current) {
      const raf = requestAnimationFrame(() => {
        fitToView(image.width, image.height);
        hasAutoFittedMain.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [image, canvasContainerRef, fitToView]);

  // Auto-fit preview result when it's generated
  useEffect(() => {
    if (
      previewUrl &&
      previewDimensions.current.w > 0 &&
      previewContainerRef.current &&
      !hasAutoFittedPreview.current
    ) {
      const timer = setTimeout(() => {
        pFitToView(previewDimensions.current.w, previewDimensions.current.h);
        hasAutoFittedPreview.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [previewUrl, previewContainerRef, pFitToView]);

  const parseAspectRatio = (ar: string): number | null => {
    if (ar === "free") return null;
    const [w, h] = ar.split(":").map(Number);
    return w / h;
  };

  const generateProcessedCanvas = useCallback(() => {
    if (!image || points.length < 3) return null;

    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x));
    const maxY = Math.max(...points.map((p) => p.y));
    const width = maxX - minX;
    const height = maxY - minY;

    const pad = Math.ceil(Math.max(0, brState.softness));
    const outWidth = Math.ceil(Math.max(1, width + pad * 2));
    const outHeight = Math.ceil(Math.max(1, height + pad * 2));

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    const sampled = sampleBackground(image, points);
    const finalSolidColorRgb = sampled;
    const finalSolidColorStr = `rgb(${finalSolidColorRgb.r}, ${finalSolidColorRgb.g}, ${finalSolidColorRgb.b})`;

    const isSolid = brState.backgroundMode === "chroma-solid";
    const isChroma = brState.backgroundMode === "chroma-transparent";

    // 1. Create a "clean" character cutout
    const charCanvas = document.createElement("canvas");
    charCanvas.width = outWidth;
    charCanvas.height = outHeight;
    const cctx = charCanvas.getContext("2d");
    if (cctx) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = outWidth;
      maskCanvas.height = outHeight;
      const mctx = maskCanvas.getContext("2d");
      if (mctx) {
        mctx.fillStyle = "black";
        mctx.beginPath();
        mctx.moveTo(points[0].x - minX + pad, points[0].y - minY + pad);
        for (let i = 1; i < points.length; i++)
          mctx.lineTo(points[i].x - minX + pad, points[i].y - minY + pad);
        mctx.closePath();
        mctx.fill();

        cctx.drawImage(image, -minX + pad, -minY + pad);
        cctx.globalCompositeOperation = "destination-in";
        cctx.drawImage(maskCanvas, 0, 0);
      }
    }

    if (isSolid) {
      ctx.fillStyle = finalSolidColorStr;
      ctx.fillRect(0, 0, outWidth, outHeight);
      ctx.drawImage(charCanvas, 0, 0);
      applySolidFillChroma(ctx, outWidth, outHeight, sampled, finalSolidColorRgb, brState);
    } else if (isChroma) {
      ctx.drawImage(charCanvas, 0, 0);
      applyChromaKey(ctx, outWidth, outHeight, sampled, brState);
    } else {
      ctx.drawImage(charCanvas, 0, 0);
    }

    let finalCanvas = canvas;

    if (brState.backgroundMode === "chroma-transparent" && brState.autoCrop) {
      const imageData = ctx.getImageData(0, 0, outWidth, outHeight);
      const data = imageData.data;
      let gMinX = outWidth,
        gMinY = outHeight,
        gMaxX = 0,
        gMaxY = 0;
      let found = false;

      for (let y = 0; y < outHeight; y++) {
        for (let x = 0; x < outWidth; x++) {
          const idx = (y * outWidth + x) * 4;
          if (data[idx + 3] > 0) {
            if (x < gMinX) gMinX = x;
            if (y < gMinY) gMinY = y;
            if (x > gMaxX) gMaxX = x;
            if (y > gMaxY) gMaxY = y;
            found = true;
          }
        }
      }

      if (found) {
        const cropPadding = 2;
        const cropX = Math.max(0, gMinX - cropPadding);
        const cropY = Math.max(0, gMinY - cropPadding);
        const cropW = Math.min(outWidth - cropX, gMaxX - gMinX + 1 + cropPadding * 2);
        const cropH = Math.min(outHeight - cropY, gMaxY - gMinY + 1 + cropPadding * 2);

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = cropW;
        cropCanvas.height = cropH;
        const cctx = cropCanvas.getContext("2d");
        if (cctx) {
          cctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          finalCanvas = cropCanvas;
        }
      }
    }

    const targetRatio = parseAspectRatio(brState.aspectRatio);
    if (targetRatio) {
      const currentW = finalCanvas.width;
      const currentH = finalCanvas.height;
      const currentRatio = currentW / currentH;

      let targetW = currentW,
        targetH = currentH;
      if (currentRatio > targetRatio) {
        targetH = currentW / targetRatio;
      } else {
        targetW = currentH * targetRatio;
      }

      const arCanvas = document.createElement("canvas");
      arCanvas.width = targetW;
      arCanvas.height = targetH;
      const actx = arCanvas.getContext("2d");
      if (actx) {
        if (isSolid) {
          actx.fillStyle = finalSolidColorStr;
          actx.fillRect(0, 0, targetW, targetH);
        }
        const offsetX = (targetW - currentW) / 2;
        const offsetY = (targetH - currentH) / 2;
        actx.drawImage(finalCanvas, offsetX, offsetY);
        finalCanvas = arCanvas;
      }
    }

    return finalCanvas;
  }, [image, points, brState, parseAspectRatio]);

  const processCutout = useCallback(
    async (silent = false, includeEffects = true) => {
      setIsProcessing(true);
      await new Promise((r) => setTimeout(r, 300));
      const canvas = generateProcessedCanvas();
      if (canvas) {
        setPreviewUrl(canvas.toDataURL("image/png"));
        previewDimensions.current = { w: canvas.width, h: canvas.height };
        hasAutoFittedPreview.current = false;
        if (!silent) toast.success("Cutout processed!");

        // Completion effects
        if (includeEffects) {
          setTimeout(() => {
            resultsRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
            confetti({
              particleCount: 100,
              spread: 70,
              origin: { y: 0.6 },
              colors: ["#4ade80", "#22c55e", "#3b82f6"],
            });
          }, 100);
        }
      }
      setIsProcessing(false);
    },
    [generateProcessedCanvas],
  );

  const draw = useCallback(() => {
    const canvas = localCanvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { zoom, offset } = view;
    const container = canvasContainerRef.current;
    if (!container) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = container.clientWidth * dpr;
    const targetH = container.clientHeight * dpr;

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);

    // Enable high-quality smoothing for zoomed-out views
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    ctx.save();
    ctx.translate(offset.x, offset.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(image, 0, 0);

    if (points.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, image.width, image.height);
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      if (isClosed) ctx.closePath();
      else if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.clip("evenodd");
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, image.width, image.height);
      ctx.restore();
    }
    ctx.restore();

    if (points.length > 0) {
      const toScreen = (p: Point) => ({
        x: p.x * zoom + offset.x,
        y: p.y * zoom + offset.y,
      });

      const screenPoints = points.map(toScreen);
      const screenMouse = mousePos ? toScreen(mousePos) : null;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < screenPoints.length; i++)
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);

      if (isClosed) {
        ctx.closePath();
        ctx.strokeStyle = "#00ff00";
        ctx.fillStyle = "rgba(0, 255, 0, 0.2)";
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
      } else {
        if (screenMouse) ctx.lineTo(screenMouse.x, screenMouse.y);
        ctx.strokeStyle = "#ff0000";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      screenPoints.forEach((p, i) => {
        const isHovered = i === hoveredPointIndex;
        const isDragged = i === draggedPointIndex;

        ctx.fillStyle = i === 0 ? (isClosed ? "#00ff00" : "#ffff00") : "#ff0000";

        if (isHovered || isDragged) {
          ctx.strokeStyle = "white";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        if (i === 0 && screenMouse && !isClosed && points.length > 2) {
          const dist = Math.sqrt((screenMouse.x - p.x) ** 2 + (screenMouse.y - p.y) ** 2);
          if (dist < 20) {
            ctx.strokeStyle = "#00ff00";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      });
      ctx.restore();
    }
    ctx.restore();
  }, [
    image,
    points,
    view,
    canvasContainerRef,
    mousePos,
    isClosed,
    draggedPointIndex,
    hoveredPointIndex,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getCanvasPoint = (e: React.MouseEvent | React.WheelEvent | WheelEvent): Point => {
    const canvas = localCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.offset.x) / view.zoom,
      y: (e.clientY - rect.top - view.offset.y) / view.zoom,
    };
  };

  const undoLastPoint = useCallback(() => {
    if (isClosed) setIsClosed(false);
    else setPoints((prev) => prev.slice(0, -1));
  }, [isClosed]);

  const clearSelection = useCallback(() => {
    setPoints([]);
    setIsClosed(false);
    setPreviewUrl(null);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!image) return;
    if (e.button === 2) {
      e.preventDefault();
      undoLastPoint();
      return;
    }

    const p = getCanvasPoint(e);
    const { zoom } = view;

    // Check if clicking near a point to drag
    if (isClosed) {
      const threshold = 10 / zoom; // 10 screen pixels
      const index = points.findIndex(
        (pt) => Math.sqrt((pt.x - p.x) ** 2 + (pt.y - p.y) ** 2) < threshold,
      );
      if (index !== -1) {
        setDraggedPointIndex(index);
        return;
      }
    }

    dragStartPos.current = { x: e.clientX, y: e.clientY };
    hasDragged.current = false;
    canvasViewport.startPanning(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!image) return;
    const p = getCanvasPoint(e);
    setMousePos(p);

    if (draggedPointIndex !== null) {
      setPoints((prev) => {
        const next = [...prev];
        next[draggedPointIndex] = p;
        return next;
      });
      return;
    }

    if (isClosed) {
      const { zoom } = view;
      const threshold = 10 / zoom;
      const index = points.findIndex(
        (pt) => Math.sqrt((pt.x - p.x) ** 2 + (pt.y - p.y) ** 2) < threshold,
      );
      setHoveredPointIndex(index !== -1 ? index : null);
    } else {
      setHoveredPointIndex(null);
    }

    if (dragStartPos.current) {
      const dist = Math.sqrt(
        (e.clientX - dragStartPos.current.x) ** 2 + (e.clientY - dragStartPos.current.y) ** 2,
      );
      if (dist > 5) hasDragged.current = true;
    }

    canvasViewport.updatePanning(e);
  };

  const handleMouseLeave = () => {
    if (!image) return;
    canvasViewport.stopPanning();
    dragStartPos.current = null;
    setMousePos(null);
    setDraggedPointIndex(null);
    setHoveredPointIndex(null);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!image) return;

    if (draggedPointIndex !== null) {
      setDraggedPointIndex(null);
      processCutout(true, false); // Auto-regenerate without animations
      return;
    }

    const wasDrag = hasDragged.current;
    canvasViewport.stopPanning();
    dragStartPos.current = null;

    if (!wasDrag && image && !isClosed && e.button === 0) {
      const p = getCanvasPoint(e);
      const now = Date.now();
      if (now - lastClickTime < 300 && points.length > 2) {
        setIsClosed(true);
        setLastClickTime(0);
        processCutout(true);
        return;
      }
      setLastClickTime(now);
      if (points.length > 2) {
        const { zoom, offset } = view;
        const firstPoint = points[0];
        const screenFirst = {
          x: firstPoint.x * zoom + offset.x,
          y: firstPoint.y * zoom + offset.y,
        };
        const canvas = localCanvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const screenClick = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          };
          const dist = Math.sqrt(
            (screenClick.x - screenFirst.x) ** 2 + (screenClick.y - screenFirst.y) ** 2,
          );
          if (dist < 20) {
            setIsClosed(true);
            processCutout(true);
            return;
          }
        }
      }
      setPoints([...points, p]);
    }
  };

  useEffect(() => {
    const canvas = localCanvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      canvasViewport.handleWheel(e, canvas);
    };
    const preventDefault = (e: Event) => e.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", preventDefault, { passive: false });
    canvas.addEventListener("gesturechange", preventDefault, {
      passive: false,
    });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", preventDefault);
      canvas.removeEventListener("gesturechange", preventDefault);
    };
  }, [canvasViewport]);

  useEffect(() => {
    const container = previewViewport.containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      previewViewport.handleWheel(e, container);
    };
    const preventDefault = (e: Event) => e.preventDefault();
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("gesturestart", preventDefault, {
      passive: false,
    });
    container.addEventListener("gesturechange", preventDefault, {
      passive: false,
    });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("gesturestart", preventDefault);
      container.removeEventListener("gesturechange", preventDefault);
    };
  }, [previewViewport]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undoLastPoint();
      } else if (e.key === "Enter" && points.length > 2 && !isClosed) {
        e.preventDefault();
        setIsClosed(true);
        processCutout(true);
      } else if (e.key === " ") {
        e.preventDefault();
        clearSelection();
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [points, isClosed, undoLastPoint, clearSelection, processCutout]);

  const exportClippedImage = () => {
    if (previewUrl) {
      const link = document.createElement("a");
      link.download = "cutout.png";
      link.href = previewUrl;
      link.click();
      toast.success("Image exported successfully!");
    }
  };

  const handleResetCanvas = () => {
    if (image) canvasViewport.fitToView(image.width, image.height);
    else canvasViewport.resetView();
  };

  const handleResetPreview = () => {
    if (previewDimensions.current.w > 0) {
      previewViewport.fitToView(previewDimensions.current.w, previewDimensions.current.h);
    } else {
      previewViewport.resetView();
    }
  };

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Lasso Cutout Tool
        </h1>
        <p className="text-muted-foreground">
          Draw precise polygons to extract objects from any image.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card className="p-4 space-y-4 h-fit ring-1 ring-primary/10 shadow-md">
            <div className="text-xs text-muted-foreground space-y-2">
              <p className="font-semibold text-foreground">Shortcuts:</p>
              <div className="grid grid-cols-2 gap-y-1 border rounded-md p-3 bg-muted/20">
                <span>Finish:</span>{" "}
                <span className="font-mono bg-muted px-1 rounded text-[10px]">
                  Enter / Double-Click
                </span>
                <span>Undo:</span>{" "}
                <span className="font-mono bg-muted px-1 rounded text-[10px]">
                  Ctrl+Z / Right-Click
                </span>
                <span>Clear:</span>{" "}
                <span className="font-mono bg-muted px-1 rounded text-[10px]">Space / Esc</span>
                <span>Move:</span>{" "}
                <span className="font-mono bg-muted px-1 rounded text-[10px]">Click & Drag</span>
                <span>Zoom:</span>{" "}
                <span className="font-mono bg-muted px-1 rounded text-[10px]">Scroll Wheel</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6">
          <Card
            className="relative overflow-hidden min-h-150 flex flex-col shadow-xl p-0 gap-0 ring-1 ring-primary/10"
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="flex items-center justify-between p-2 bg-muted/30 border-b backdrop-blur-sm z-10">
              <div className="flex items-center gap-1">
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  onChange={handleImageUpload}
                  accept="image/*"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-2"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" /> {image ? "Change" : "Upload"}
                </Button>
                <div className="w-px h-4 bg-border mx-1" />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title="Toggle Grid Color"
                  onClick={() => setGridTheme((prev) => (prev === "light" ? "dark" : "light"))}
                >
                  <Palette
                    className={cn(
                      "h-4 w-4",
                      gridTheme === "dark" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                </Button>
                <ViewportControls
                  onZoomIn={() => image && setZoomIn(image.width, image.height)}
                  onZoomOut={() => image && setZoomOut(image.width, image.height)}
                  onReset={handleResetCanvas}
                />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={undoLastPoint}
                  disabled={points.length === 0}
                >
                  <Undo className="mr-2 h-4 w-4" /> Undo
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={clearSelection}
                  disabled={points.length === 0}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Clear
                </Button>
              </div>
            </div>

            <div
              ref={canvasContainerRef}
              className={cn(
                "flex-1 relative overflow-hidden group transition-all duration-500",
                image
                  ? gridTheme === "light"
                    ? "checkerboard-light"
                    : "checkerboard-dark"
                  : "bg-muted/5 hover:bg-muted/10 cursor-pointer",
                isDragging && "ring-4 ring-primary ring-inset bg-primary/5",
              )}
              onClick={() => !image && fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {!image ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground animate-in fade-in zoom-in duration-500">
                  <div className="w-20 h-20 rounded-full bg-primary/5 flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-primary/10 transition-all duration-300">
                    <Upload className="h-10 w-10 text-primary/40 group-hover:text-primary transition-colors" />
                  </div>
                  <p className="font-medium text-lg text-foreground/60">Upload an image to start</p>
                  <p className="text-sm opacity-60">or click the button in the toolbar</p>
                </div>
              ) : (
                <canvas
                  ref={localCanvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  className={cn(
                    "absolute top-0 left-0 w-full h-full",
                    draggedPointIndex !== null
                      ? "cursor-grabbing"
                      : hoveredPointIndex !== null
                        ? "cursor-grab"
                        : "cursor-crosshair",
                    isPanning && "cursor-grabbing",
                  )}
                />
              )}
              {image && (
                <ZoomIndicator
                  zoom={view.zoom}
                  baseZoom={baseView.zoom}
                  className="absolute bottom-4 right-4"
                />
              )}
            </div>
          </Card>

          {isClosed && (
            <Card className="p-4 space-y-4 animate-in slide-in-from-top-4 duration-500 shadow-md ring-1 ring-primary/10">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-5 h-5 text-primary" />
                <CardTitle className="text-lg">Process Selection</CardTitle>
              </div>
              <div className="pt-2 border-t border-dashed">
                <BackgroundRemovalSettings
                  state={brState}
                  setState={setBrState}
                  compact={true}
                  renderFooter={() => (
                    <Button
                      onClick={() => processCutout()}
                      disabled={isProcessing}
                      size="default"
                      className="bg-primary hover:bg-primary/90 h-10 px-6 shadow-lg"
                    >
                      {isProcessing ? (
                        <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
                      ) : (
                        <Sparkles className="mr-2 h-5 w-5" />
                      )}
                      Process Cutout
                    </Button>
                  )}
                />
              </div>
            </Card>
          )}

          {previewUrl && (
            <div
              ref={resultsRef}
              className="animate-in fade-in slide-in-from-bottom-8 duration-700"
            >
              <Card className="shadow-2xl ring-1 ring-primary/10 overflow-hidden p-0 gap-0">
                <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0 bg-muted/20 border-b px-2 py-2">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">Final Result</CardTitle>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Toggle Grid"
                      onClick={() => setGridTheme((prev) => (prev === "light" ? "dark" : "light"))}
                    >
                      <Palette
                        className={cn(
                          "h-4 w-4",
                          gridTheme === "dark" ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                    </Button>
                  </div>
                  <div className="flex gap-1 items-center">
                    <ViewportControls
                      onZoomIn={() =>
                        previewDimensions.current.w > 0 &&
                        pSetZoomIn(previewDimensions.current.w, previewDimensions.current.h)
                      }
                      onZoomOut={() =>
                        previewDimensions.current.w > 0 &&
                        pSetZoomOut(previewDimensions.current.w, previewDimensions.current.h)
                      }
                      onReset={handleResetPreview}
                    />
                    <div className="w-px h-4 bg-border mx-1" />
                    <Button onClick={exportClippedImage} size="sm" className="h-8 gap-2">
                      <Download className="h-4 w-4" /> Export
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div
                    ref={previewContainerRef}
                    className={cn(
                      "aspect-square min-h-100 overflow-hidden relative cursor-move touch-none bg-muted/5",
                      gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                    )}
                    onMouseDown={previewViewport.startPanning}
                    onMouseMove={previewViewport.updatePanning}
                    onMouseUp={previewViewport.stopPanning}
                    onMouseLeave={previewViewport.stopPanning}
                  >
                    <img
                      ref={previewCanvasRef}
                      src={previewUrl}
                      alt="Result"
                      className="absolute top-0 left-0 shadow-2xl max-w-none"
                      style={{
                        transform: `translate(${pView.offset.x}px, ${pView.offset.y}px) scale(${pView.zoom})`,
                        transformOrigin: "0 0",
                      }}
                      draggable={false}
                    />
                    <ZoomIndicator
                      zoom={pView.zoom}
                      baseZoom={pBaseView.zoom}
                      className="absolute bottom-4 right-4"
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
