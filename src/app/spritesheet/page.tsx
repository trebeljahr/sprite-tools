"use client";

import * as React from "react";
import { useState, useRef, useEffect, useLayoutEffect, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { fireConfetti } from "@/lib/confetti";
import {
  Scissors,
  Download,
  Loader2,
  Play,
  Pause,
  RefreshCw,
  ImageIcon,
  ChevronLeft,
  ChevronRight,
  Palette,
  Check,
  Crop,
  RotateCcw,
  Undo2,
  Redo2,
  Video,
  Grid3x3,
  Layers,
  FileArchive,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  BackgroundRemovalSettings,
  type BackgroundRemovalState,
} from "@/components/background-removal-settings";
import {
  CropOverlay,
  EMPTY_CROP as OVERLAY_EMPTY,
  isCropEmpty,
  type FrameCrop,
} from "@/components/crop-overlay";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import {
  usePipeline,
  buildImportVideoStep,
  buildImportSheetStep,
  buildChromaKeyStep,
  buildAutoCropStep,
  buildManualCropStep,
  buildImportAsepriteStep,
} from "@/lib/pipeline/use-pipeline";
import { stitchSheet, exportAsZip } from "@/lib/pipeline/export";
import { detectSheetGrid, isAsepriteFilename, type SheetDetection } from "@/lib/pipeline/import";
import {
  type GridMargin,
  type GridSpacing,
  isZeroPadding,
  ZERO_PADDING,
} from "@/lib/pipeline/grid";
import {
  type AutoCropConfig,
  type ChromaKeyConfig,
  DEDUPE_THRESHOLD_HELP,
  type Frame,
  type BackgroundMode,
  type PipelineStep,
} from "@/lib/pipeline/types";
import { composeCrops, rasterizeFrames } from "@/lib/pipeline/transforms";
import { findDuplicateFrames } from "@/lib/pipeline/dedupe-core";
import {
  AsepriteSource,
  describeGridPadding,
  FrameImg,
  SheetSource,
  useAsepriteSource,
  VideoSource,
} from "@/components/pipeline-source";

// -----------------------------------------------------------------
// <FrameItem>: single thumb in the Frame Selection grid.
// -----------------------------------------------------------------

const FrameItem = React.memo(function FrameItemInner({
  index,
  frame,
  isSelected,
  isActive,
  gridTheme,
  onMouseDown,
  onMouseEnter,
}: {
  index: number;
  frame: Frame;
  isSelected: boolean;
  isActive: boolean;
  gridTheme: "light" | "dark";
  onMouseDown: (index: number) => void;
  onMouseEnter: (index: number) => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control
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
      <FrameImg
        frame={frame}
        alt={`F${index}`}
        className="w-full h-full object-contain pointer-events-none"
      />
      <div className="absolute top-1 right-1">
        {isSelected ? (
          <div className="w-4 h-4 bg-primary rounded shadow-sm border border-primary-foreground/20 flex items-center justify-center">
            <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />
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

const calculateSmartColumns = (count: number) => {
  if (count <= 1) return 1;
  return Math.ceil(Math.sqrt(count));
};

type SourceTab = "video" | "sheet" | "aseprite";

// -----------------------------------------------------------------
// Main content
// -----------------------------------------------------------------

function SpritesheetContent() {
  const searchParams = useSearchParams();
  const pipeline = usePipeline();

  // ------- Source selection -------
  const [sourceTab, setSourceTab] = useState<SourceTab>("video");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [sheetFile, setSheetFile] = useState<File | null>(null);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetCols, setSheetCols] = useState(8);
  const [sheetRows, setSheetRows] = useState(1);
  const [sheetMargin, setSheetMargin] = useState<GridMargin>(ZERO_PADDING.margin);
  const [sheetSpacing, setSheetSpacing] = useState<GridSpacing>(ZERO_PADDING.spacing);
  const [detectedGrid, setDetectedGrid] = useState<SheetDetection | null>(null);
  const [fps, setFps] = useState(10);

  // ------- Chroma-key (applied on "Re-do Background Removal") -------
  const [brState, setBrState] = useState<BackgroundRemovalState>({
    backgroundMode: "chroma-transparent",
    autoCrop: true,
    aspectRatio: "free",
    similarity: 30,
    softness: 10,
    spill: 20,
    choke: 1,
  });

  // ------- Manual crop (overlay-driven) -------
  const [pendingCrop, setPendingCrop] = useState<FrameCrop>(OVERLAY_EMPTY);
  const [appliedCrop, setAppliedCrop] = useState<FrameCrop>(OVERLAY_EMPTY);
  const cropDirty = useMemo(() => !isCropEmpty(pendingCrop), [pendingCrop]);

  // ------- Selection -------
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [isDraggingSelection, setIsDraggingSelection] = useState(false);
  const [dragAction, setDragAction] = useState<"select" | "deselect" | null>(null);

  // ------- Duplicate detection -------
  // Deliberately *not* a pipeline step here: this page already has a frame
  // grid, so the honest affordance is to deselect the duplicates in place —
  // the user sees exactly which frames are about to go and can put any of
  // them back by hand before exporting.
  const [dedupeTolerance, setDedupeTolerance] = useState(0);
  const [dedupeNotice, setDedupeNotice] = useState<{ forOutput: unknown; text: string } | null>(
    null,
  );
  const [isFindingDuplicates, setIsFindingDuplicates] = useState(false);

  // ------- Stitched sheet preview -------
  const [sheetPreviewUrl, setSheetPreviewUrl] = useState<string | null>(null);
  const [sheetGrid, setSheetGrid] = useState({ cols: 1, rows: 1 });
  const [columns, setColumns] = useState(8);
  const [isCompiling, setIsCompiling] = useState(false);

  // ------- Animation playback -------
  const [previewIndex, setPreviewIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackRef = useRef<NodeJS.Timeout | null>(null);

  // Layer / tag / hidden-layer changes after an import re-run that import in
  // place, so the frames on screen always match the picker. Only when the
  // pipeline is still showing this very file: a newly picked file waits for
  // Import Frames like every other source.
  const aseprite = useAsepriteSource({
    onConfigChange: (config, file) => {
      const step = pipeline.state.steps.find((s) => s.kind === "import-aseprite");
      if (!step || step.kind !== "import-aseprite" || pipeline.state.source?.file !== file) return;
      // A different tag is a different frame list, so indices selected in the
      // old one would point at unrelated frames.
      if ((step.config.tag ?? null) !== (config.tag ?? null)) {
        setSelectedIndices(new Set());
        setPreviewIndex(0);
      }
      pipeline.updateStep(step.id, { ...config, sourceName: file.name }, true);
    },
  });

  // ------- Viewport -------
  const previewViewport = useViewport();
  const { view: pView } = previewViewport;
  const sheetViewport = useViewport();
  const { view: sView } = sheetViewport;
  const hasAutoFittedPreview = useRef(false);
  const hasAutoFittedSheet = useRef(false);
  const frameDimensions = useRef({ w: 0, h: 0 });
  const sheetDimensions = useRef({ w: 0, h: 0 });

  // ------- Misc UI state -------
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = previewViewport.containerRef;
  const sheetContainerRef = sheetViewport.containerRef;

  // Receive ?videoUrl= from the Animate step
  useEffect(() => {
    const url = searchParams.get("videoUrl");
    if (url) {
      setVideoUrl(url);
      setSourceTab("video");
      toast.success("Animation loaded from AI Animation");
    }
  }, [searchParams]);

  const hasInitedTutorial = useRef(false);

  // Pipeline output drives what the preview/selection show
  const output = pipeline.state.output;
  const allFrames = output?.frames ?? [];

  const activeIndices = useMemo(() => {
    const idx: number[] = [];
    for (let i = 0; i < allFrames.length; i++) {
      if (selectedIndices.size === 0 || selectedIndices.has(i)) idx.push(i);
    }
    return idx;
  }, [allFrames.length, selectedIndices]);

  const activeFrames = useMemo(
    () => activeIndices.map((i) => allFrames[i]),
    [activeIndices, allFrames],
  );

  const currentGlobalIndex = activeIndices[previewIndex] ?? -1;

  // Track frame dimensions for viewport fit
  useEffect(() => {
    if (allFrames.length > 0) {
      frameDimensions.current = {
        w: output!.stats.width,
        h: output!.stats.height,
      };
      hasAutoFittedPreview.current = false;
    }
  }, [output, allFrames.length]);

  // Reset preview index if it goes out of range
  if (activeFrames.length > 0 && previewIndex >= activeFrames.length) {
    setPreviewIndex(0);
  }

  // ------- Helpers -------

  const chromaConfigFromBr = (br: BackgroundRemovalState): ChromaKeyConfig => ({
    mode: br.backgroundMode as BackgroundMode,
    similarity: br.similarity,
    softness: br.softness,
    spill: br.spill,
    choke: br.choke,
    autoDetermineFillColor: true,
  });

  const autoCropConfigFromBr = (br: BackgroundRemovalState): AutoCropConfig => ({
    enabled: br.autoCrop,
    padding: 2,
    aspectRatio: br.aspectRatio,
  });

  // ------- Source file handlers -------

  const clearSourceState = () => {
    setSheetPreviewUrl(null);
    setShowResults(false);
    setPreviewIndex(0);
    setIsPlaying(false);
    setAppliedCrop(OVERLAY_EMPTY);
    setPendingCrop(OVERLAY_EMPTY);
    setSelectedIndices(new Set());
    hasAutoFittedPreview.current = false;
    hasAutoFittedSheet.current = false;
  };

  const handleVideoFile = (file: File) => {
    if (!file.type.startsWith("video/")) {
      toast.error("Unsupported file type. Please upload a video.");
      return;
    }
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    clearSourceState();
    // Video frames typically come from an opaque recording; default chroma
    // removal to on (the original behavior).
    setBrState((prev) => ({ ...prev, backgroundMode: "chroma-transparent" }));
  };

  const handleAsepriteFile = (file: File) => {
    if (!isAsepriteFilename(file.name)) {
      toast.error("Unsupported file type. Please upload a .ase or .aseprite file.");
      return;
    }
    aseprite.pick(file);
    clearSourceState();
    // An .ase composites onto a transparent canvas already — chroma-keying it
    // would eat the artwork, so start in passthrough like the sheet source.
    setBrState((prev) => ({ ...prev, backgroundMode: "transparent-cutout" }));
  };

  const handleSheetFile = async (file: File) => {
    // Extension, not MIME: browsers leave `type` empty for .ase files, so the
    // image guard below would reject one with a misleading message.
    if (isAsepriteFilename(file.name)) {
      setSourceTab("aseprite");
      handleAsepriteFile(file);
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("Unsupported file type. Please upload an image.");
      return;
    }
    setSheetFile(file);
    const url = URL.createObjectURL(file);
    setSheetUrl(url);
    clearSourceState();
    // Sheets usually come with the background already removed; default the
    // chroma-key to passthrough. User can re-enable via the Auto Background
    // Removal switch.
    setBrState((prev) => ({ ...prev, backgroundMode: "transparent-cutout" }));
    // Drop the previous sheet's padding before detecting: carrying it over onto
    // a sheet detection can't read would block Split Sheet on a fit error, where
    // flush is both this tool's old behaviour and the safer guess.
    setSheetMargin(ZERO_PADDING.margin);
    setSheetSpacing(ZERO_PADDING.spacing);
    // Try auto-detection
    try {
      const det = await detectSheetGrid(file);
      if (det.confidence > 0) {
        setDetectedGrid(det);
        setSheetCols(det.cols);
        setSheetRows(det.rows);
        setSheetMargin(det.margin);
        setSheetSpacing(det.spacing);
        const padding = describeGridPadding(det.margin, det.spacing);
        toast.success(`Detected ${det.cols}×${det.rows} grid${padding ? ` with ${padding}` : ""}`);
      }
    } catch {
      // Silent — user can still specify grid manually.
    }
  };

  const handleSingleFile = (file: File) => {
    if (isAsepriteFilename(file.name)) {
      setSourceTab("aseprite");
      handleAsepriteFile(file);
    } else if (file.type.startsWith("video/")) {
      setSourceTab("video");
      handleVideoFile(file);
    } else if (file.type.startsWith("image/")) {
      setSourceTab("sheet");
      void handleSheetFile(file);
    } else {
      toast.error("Unsupported file type.");
    }
  };

  const onFilesDropped = (files: File[]) => {
    if (files.length === 0) return;
    handleSingleFile(files[0]);
  };

  // Global paste: video → Video tab; image → Sheet tab
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      handleSingleFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // biome-ignore lint/correctness/useExhaustiveDependencies: handleSingleFile is recreated each render but only closes over stable setters; rebinding listener is intentional
  }, [handleSingleFile]);

  // ?tutorial=1 from the homepage Quickstart button: preload a bundled
  // sample sheet so step 1 is a one-click experience. (The strip itself
  // is opened by useTutorial via the same URL param + localStorage logic.)
  useEffect(() => {
    if (hasInitedTutorial.current) return;
    if (searchParams.get("tutorial") !== "1") return;
    hasInitedTutorial.current = true;
    setSourceTab("sheet");
    void (async () => {
      try {
        const res = await fetch("/samples/sheet.png");
        const blob = await res.blob();
        const file = new File([blob], "sheet.png", { type: "image/png" });
        await handleSheetFile(file);
      } catch {
        // If the sample fails to load, leave the strip open with step 1
        // unsatisfied — the user can still upload their own file.
      }
    })();
    // biome-ignore lint/correctness/useExhaustiveDependencies: ref guard makes this one-shot
  }, [searchParams, handleSheetFile]);

  // ------- Kickoff / re-run helpers -------

  // Zero padding is left off the step config entirely, so a flush sheet keeps
  // the exact config (and therefore the exact step cache key) it had before.
  const sheetPadding = () => {
    const padding = { margin: sheetMargin, spacing: sheetSpacing };
    return isZeroPadding(padding) ? {} : padding;
  };

  const runFromSource = async (sourceTabOverride?: SourceTab, crop: FrameCrop = appliedCrop) => {
    const tab = sourceTabOverride ?? sourceTab;
    let steps: PipelineStep[];
    if (tab === "video") {
      if (!videoUrl && !videoFile) return;
      const src = videoFile ?? videoUrl ?? undefined;
      pipeline.setSource({ file: videoFile ?? undefined, url: videoUrl ?? undefined });
      steps = [
        buildImportVideoStep({ fps }, videoFile?.name),
        buildChromaKeyStep(chromaConfigFromBr(brState)),
        buildAutoCropStep(autoCropConfigFromBr(brState)),
        buildManualCropStep(crop),
      ];
      void src;
    } else if (tab === "aseprite") {
      if (!aseprite.file) return;
      pipeline.setSource({ file: aseprite.file });
      steps = [
        buildImportAsepriteStep(aseprite.config, aseprite.file.name),
        buildChromaKeyStep(chromaConfigFromBr(brState)),
        buildAutoCropStep(autoCropConfigFromBr(brState)),
        buildManualCropStep(crop),
      ];
    } else {
      if (!sheetFile && !sheetUrl) return;
      pipeline.setSource({ file: sheetFile ?? undefined, url: sheetUrl ?? undefined });
      steps = [
        buildImportSheetStep(
          { cols: sheetCols, rows: sheetRows, ...sheetPadding() },
          sheetFile?.name,
        ),
        buildChromaKeyStep(chromaConfigFromBr(brState)),
        buildAutoCropStep(autoCropConfigFromBr(brState)),
        buildManualCropStep(crop),
      ];
    }
    // Only the first run of a given source is non-undoable; re-runs are recorded.
    const shouldRecord = pipeline.state.steps.length > 0;
    pipeline.setSteps(steps, shouldRecord);
    setShowResults(true);
  };

  const redoBgRemoval = async () => {
    const chromaStep = pipeline.state.steps.find((s) => s.kind === "chroma-key");
    const autoStep = pipeline.state.steps.find((s) => s.kind === "auto-crop");
    if (chromaStep) {
      pipeline.updateStep(chromaStep.id, chromaConfigFromBr(brState), true);
    }
    if (autoStep) {
      pipeline.updateStep(autoStep.id, autoCropConfigFromBr(brState), true);
    }
  };

  // ------- Manual crop apply/reset -------
  const applyCrop = async () => {
    const newCrop = composeCrops(appliedCrop, pendingCrop);
    setAppliedCrop(newCrop);
    setPendingCrop(OVERLAY_EMPTY);
    const manualStep = pipeline.state.steps.find((s) => s.kind === "manual-crop");
    if (manualStep) {
      pipeline.updateStep(manualStep.id, { crop: newCrop }, true);
    }
  };

  const resetCrop = async () => {
    if (isCropEmpty(appliedCrop) && isCropEmpty(pendingCrop)) return;
    setAppliedCrop(OVERLAY_EMPTY);
    setPendingCrop(OVERLAY_EMPTY);
    const manualStep = pipeline.state.steps.find((s) => s.kind === "manual-crop");
    if (manualStep) {
      pipeline.updateStep(manualStep.id, { crop: OVERLAY_EMPTY }, true);
    }
  };

  // ------- Compile / export -------

  const compileSheet = async () => {
    if (activeFrames.length === 0 || !output) return;
    setIsCompiling(true);
    if (sheetPreviewUrl) URL.revokeObjectURL(sheetPreviewUrl);
    try {
      const { blob, width, height, cols, rows } = await stitchSheet(
        { frames: activeFrames, stats: output.stats },
        { columns },
      );
      const url = URL.createObjectURL(blob);
      setSheetPreviewUrl(url);
      const isFirstSheet = sheetDimensions.current.w === 0;
      sheetDimensions.current = { w: width, h: height };
      setSheetGrid({ cols, rows });
      if (isFirstSheet) hasAutoFittedSheet.current = false;
    } finally {
      setIsCompiling(false);
    }
  };

  // Auto-compile when output becomes available or when active frames change
  useEffect(() => {
    if (allFrames.length > 0) {
      const smart = calculateSmartColumns(activeFrames.length || allFrames.length);
      setColumns((prev) => (prev === 8 ? smart : prev));
    }
  }, [allFrames.length, activeFrames.length]);

  // compileSheet is intentionally excluded — it's recreated every render and would fire an
  // infinite loop. isCompiling is excluded for the same reason: it toggles inside compileSheet,
  // which would re-trigger this effect. Reading both via closure is correct here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above — compileSheet/isCompiling intentionally read via closure to avoid loop
  useEffect(() => {
    if (activeFrames.length > 0 && !isCompiling) {
      void compileSheet();
    }
  }, [activeFrames.length, columns, output]);

  const downloadSheet = () => {
    if (!sheetPreviewUrl) return;
    const a = document.createElement("a");
    a.href = sheetPreviewUrl;
    a.download = "spritesheet.png";
    a.click();
    setHasDownloaded(true);
  };

  const exportFramesZip = async () => {
    if (activeFrames.length === 0 || !output) return;
    setIsExportingZip(true);
    try {
      const blob = await exportAsZip({ frames: activeFrames, stats: output.stats });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sprites.zip";
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${activeFrames.length} frames as ZIP`);
      setHasDownloaded(true);
    } finally {
      setIsExportingZip(false);
    }
  };

  // ------- Confetti on first successful pipeline output -------
  const hasShownConfetti = useRef(false);
  useEffect(() => {
    if (allFrames.length > 0 && !hasShownConfetti.current) {
      hasShownConfetti.current = true;
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
      setTimeout(() => {
        fireConfetti({
          particleCount: 150,
          spread: 70,
          origin: { y: 0.9 },
          colors: ["#4ade80", "#22c55e", "#3b82f6", "#f59e0b"],
        });
      }, 500);
    }
    if (allFrames.length === 0) hasShownConfetti.current = false;
  }, [allFrames.length]);

  // ------- Auto-fit viewports -------
  useEffect(() => {
    if (
      showResults &&
      allFrames.length > 0 &&
      frameDimensions.current.w > 0 &&
      previewViewport.containerRef.current &&
      !hasAutoFittedPreview.current
    ) {
      const t = setTimeout(() => {
        previewViewport.fitToView(frameDimensions.current.w, frameDimensions.current.h);
        hasAutoFittedPreview.current = true;
      }, 100);
      return () => clearTimeout(t);
    }
  }, [allFrames.length, showResults, previewViewport]);

  useEffect(() => {
    if (
      showResults &&
      sheetPreviewUrl &&
      sheetDimensions.current.w > 0 &&
      sheetViewport.containerRef.current &&
      !hasAutoFittedSheet.current
    ) {
      const t = setTimeout(() => {
        sheetViewport.fitToView(sheetDimensions.current.w, sheetDimensions.current.h);
        hasAutoFittedSheet.current = true;
      }, 100);
      return () => clearTimeout(t);
    }
  }, [sheetPreviewUrl, showResults, sheetViewport]);

  // ------- Viewport wheel/zoom wiring -------
  useEffect(() => {
    const p = previewContainerRef.current;
    const s = sheetContainerRef.current;
    const onPrev = (e: WheelEvent) => {
      e.preventDefault();
      previewViewport.handleWheel(e, p);
    };
    const onSheet = (e: WheelEvent) => {
      e.preventDefault();
      sheetViewport.handleWheel(e, s);
    };
    const prevent = (e: Event) => e.preventDefault();
    if (p) {
      p.addEventListener("wheel", onPrev, { passive: false });
      p.addEventListener("gesturestart", prevent, { passive: false });
    }
    if (s) {
      s.addEventListener("wheel", onSheet, { passive: false });
      s.addEventListener("gesturestart", prevent, { passive: false });
    }
    return () => {
      if (p) p.removeEventListener("wheel", onPrev);
      if (s) s.removeEventListener("wheel", onSheet);
    };
  }, [previewViewport, sheetViewport, previewContainerRef, sheetContainerRef]);

  // ------- Keyboard: Undo/Redo + frame navigation -------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) pipeline.redo();
        else pipeline.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        pipeline.redo();
        return;
      }
      if (activeFrames.length === 0) return;
      if (e.key === "ArrowRight") {
        setPreviewIndex((p) => (p + 1) % activeFrames.length);
        setIsPlaying(false);
      } else if (e.key === "ArrowLeft") {
        setPreviewIndex((p) => (p - 1 + activeFrames.length) % activeFrames.length);
        setIsPlaying(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFrames.length, pipeline]);

  // ------- Animation playback -------
  useEffect(() => {
    if (isPlaying && activeFrames.length > 0) {
      playbackRef.current = setInterval(() => {
        setPreviewIndex((p) => (p + 1) % activeFrames.length);
      }, 1000 / Math.max(1, fps));
    } else if (playbackRef.current) {
      clearInterval(playbackRef.current);
    }
    return () => {
      if (playbackRef.current) clearInterval(playbackRef.current);
    };
  }, [isPlaying, activeFrames.length, fps]);

  // ------- Selection drag handlers -------
  useEffect(() => {
    const up = () => {
      setIsDraggingSelection(false);
      setDragAction(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // The notice carries the output it was measured against, so a re-run of the
  // pipeline retires it on the next render instead of needing a reset effect.
  const dedupeNoticeText = dedupeNotice?.forOutput === output ? dedupeNotice.text : null;

  // rasterizeFrames yields to the main thread between batches, so the pipeline
  // can finish a re-run (and dispose the bitmaps we were reading) mid-scan.
  // This ref lets the scan notice that and drop its now-meaningless indices.
  // Synced in a layout effect, not during render: the React Compiler is on,
  // and a layout effect still lands in the same commit as the new output —
  // well before the hook's deferred disposal of the old bitmaps.
  const latestOutputRef = useRef(output);
  useLayoutEffect(() => {
    latestOutputRef.current = output;
  }, [output]);

  const selectUnique = async () => {
    if (allFrames.length === 0 || isFindingDuplicates) return;
    const scanned = output;
    setIsFindingDuplicates(true);
    try {
      const images = await rasterizeFrames(allFrames);
      if (latestOutputRef.current !== scanned) return;
      const result = findDuplicateFrames(images, { threshold: dedupeTolerance });
      setSelectedIndices(new Set(result.keptIndices));
      setDedupeNotice({
        forOutput: scanned,
        text:
          result.removedCount === 0
            ? "No duplicates found"
            : `${result.removedCount} duplicate${result.removedCount === 1 ? "" : "s"} deselected`,
      });
    } catch (e) {
      if (latestOutputRef.current !== scanned) return;
      toast.error(`Duplicate scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsFindingDuplicates(false);
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

  // ------- Source upload zone props -------
  const uploadZoneProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    },
    onDragLeave: () => setIsDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      onFilesDropped(files);
    },
  };

  const progressPct = pipeline.state.progress
    ? Math.round(
        (pipeline.state.progress.current / Math.max(1, pipeline.state.progress.total)) * 100,
      )
    : 0;

  const hasSource =
    sourceTab === "sheet" ? !!sheetUrl : sourceTab === "aseprite" ? !!aseprite.doc : !!videoUrl;
  const sourceNoun =
    sourceTab === "sheet" ? "sprite sheet" : sourceTab === "aseprite" ? "Aseprite file" : "video";
  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        label: `Pick ${sourceTab === "aseprite" ? "an" : "a"} ${sourceNoun}`,
        hint:
          sourceTab === "sheet"
            ? "Drop a sheet image into the upload area on the left — or use the preloaded sample."
            : sourceTab === "aseprite"
              ? "Drop a .ase or .aseprite file into the upload area on the left."
              : "Drop a video file into the upload area on the left.",
        done: hasSource,
      },
      {
        label: sourceTab === "video" ? "Extract frames" : "Split into frames",
        hint:
          sourceTab === "sheet"
            ? "Confirm the columns/rows, then click Split Sheet."
            : sourceTab === "aseprite"
              ? "Pick the layers and tag you want, then click Import Frames."
              : "Set the FPS, then click Extract Raw Frames.",
        done: showResults && allFrames.length > 0,
      },
      {
        label: "Download",
        hint: "Stitched sheet PNG or per-frame ZIP — whatever your engine wants.",
        done: hasDownloaded,
      },
    ],
    [sourceTab, sourceNoun, hasSource, showResults, allFrames.length, hasDownloaded],
  );
  const tutorial = useTutorial({ id: "spritesheet", steps: tutorialSteps });

  return (
    <main className="flex-1 container max-w-7xl mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Scissors className="w-8 h-8 text-primary" />
          Sheet Builder
        </h1>
        <p className="text-muted-foreground">
          Video, sprite sheets, or Aseprite files — chroma key, crop, stitch, and export.
        </p>
        <div className="flex items-center justify-center gap-2 mt-3">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => pipeline.undo()}
            disabled={!pipeline.canUndo}
            title="Undo (⌘Z)"
          >
            <Undo2 className="w-3.5 h-3.5" /> Undo
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => pipeline.redo()}
            disabled={!pipeline.canRedo}
            title="Redo (⌘⇧Z)"
          >
            <Redo2 className="w-3.5 h-3.5" /> Redo
          </Button>
        </div>
      </div>

      <TutorialStrip
        open={tutorial.isOpen}
        steps={tutorialSteps}
        currentStep={tutorial.currentStep}
        onDismiss={tutorial.dismiss}
        onPrev={tutorial.goPrev}
        onNext={tutorial.goNext}
        onStepClick={tutorial.setCurrentStep}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column: Source + Settings + Export */}
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Start from a video, an existing sprite sheet, or an .ase/.aseprite file.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted/30 border">
                {(
                  [
                    { id: "video" as const, label: "Video", Icon: Video },
                    { id: "sheet" as const, label: "Sheet", Icon: Grid3x3 },
                    { id: "aseprite" as const, label: "Aseprite", Icon: Layers },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    type="button"
                    key={id}
                    onClick={() => setSourceTab(id)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors",
                      sourceTab === id
                        ? "bg-background shadow-sm text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" /> {label}
                  </button>
                ))}
              </div>

              {sourceTab === "video" && (
                <VideoSource
                  videoUrl={videoUrl}
                  fps={fps}
                  setFps={setFps}
                  uploadZoneProps={uploadZoneProps}
                  isDragging={isDragging}
                  onFile={handleVideoFile}
                  onRun={() => runFromSource("video")}
                  running={pipeline.state.running}
                  progressLabel={pipeline.state.progress?.step ?? ""}
                  progressPct={progressPct}
                />
              )}
              {sourceTab === "sheet" && (
                <SheetSource
                  sheetUrl={sheetUrl}
                  cols={sheetCols}
                  rows={sheetRows}
                  setCols={setSheetCols}
                  setRows={setSheetRows}
                  margin={sheetMargin}
                  spacing={sheetSpacing}
                  setMargin={setSheetMargin}
                  setSpacing={setSheetSpacing}
                  detected={detectedGrid}
                  uploadZoneProps={uploadZoneProps}
                  isDragging={isDragging}
                  onFile={handleSheetFile}
                  onRun={() => runFromSource("sheet")}
                  running={pipeline.state.running}
                  progressLabel={pipeline.state.progress?.step ?? ""}
                  progressPct={progressPct}
                />
              )}
              {sourceTab === "aseprite" && (
                <AsepriteSource
                  state={aseprite}
                  uploadZoneProps={uploadZoneProps}
                  isDragging={isDragging}
                  onFile={handleAsepriteFile}
                  onRun={() => runFromSource("aseprite")}
                  running={pipeline.state.running}
                  progressLabel={pipeline.state.progress?.step ?? ""}
                  progressPct={progressPct}
                />
              )}
            </CardContent>
          </Card>

          {/* Advanced settings collapsed by default — most first-run users
              just want to upload + extract without tuning chroma. */}
          <Card>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-accent/20 transition-colors rounded-t-lg"
              aria-expanded={showAdvanced}
            >
              <div>
                <div className="text-sm font-semibold">Advanced settings</div>
                <div className="text-xs text-muted-foreground">
                  Background removal (chroma key), auto-crop, aspect ratio
                </div>
              </div>
              <ChevronRight
                className={cn(
                  "w-4 h-4 text-muted-foreground transition-transform",
                  showAdvanced && "rotate-90",
                )}
              />
            </button>
            {showAdvanced && (
              <CardContent className="space-y-6 pt-0">
                <BackgroundRemovalSettings
                  state={brState}
                  setState={setBrState}
                  mode="chroma-only"
                />

                {showResults && (
                  <div className="space-y-4 border-t border-dashed pt-4">
                    <Button
                      onClick={redoBgRemoval}
                      disabled={pipeline.state.running || allFrames.length === 0}
                      variant="outline"
                      className="w-full"
                    >
                      {pipeline.state.running ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="mr-2 h-4 w-4 text-primary" />
                      )}
                      Re-do Background Removal
                    </Button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {showResults && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Export
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  onClick={downloadSheet}
                  disabled={!sheetPreviewUrl}
                  variant="default"
                  className="w-full"
                >
                  <ImageIcon className="w-4 h-4 mr-2" /> Download Stitched Sheet
                </Button>
                <Button
                  onClick={exportFramesZip}
                  disabled={allFrames.length === 0 || isExportingZip}
                  variant="outline"
                  className="w-full"
                >
                  {isExportingZip ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <FileArchive className="w-4 h-4 mr-2" />
                  )}
                  Export Frames as ZIP
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Preview + Sheet + Selection */}
        <div className="lg:col-span-8 space-y-6">
          {showResults && (
            <div
              ref={resultsRef}
              className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700 scroll-mt-12"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Preview */}
                <Card className="md:col-span-1 shadow-lg ring-1 ring-primary/10">
                  <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">Preview</CardTitle>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Toggle Background Grid Color"
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
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
                    <div
                      ref={previewContainerRef}
                      className={cn(
                        "aspect-square rounded-lg border overflow-hidden relative cursor-move touch-none",
                        gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                      )}
                      onMouseDown={previewViewport.startPanning}
                      onMouseMove={previewViewport.updatePanning}
                      onMouseUp={previewViewport.stopPanning}
                      onMouseLeave={previewViewport.stopPanning}
                    >
                      {activeFrames.length > 0 && activeFrames[previewIndex] ? (
                        <>
                          <div
                            className="absolute top-0 left-0"
                            style={{
                              width: frameDimensions.current.w || undefined,
                              height: frameDimensions.current.h || undefined,
                              transform: `translate(${pView.offset.x}px, ${pView.offset.y}px) scale(${pView.zoom})`,
                              transformOrigin: "0 0",
                            }}
                          >
                            <FrameImg
                              frame={activeFrames[previewIndex]}
                              alt="Preview"
                              className="block max-w-none"
                              style={{
                                width: frameDimensions.current.w || undefined,
                                height: frameDimensions.current.h || undefined,
                              }}
                              draggable={false}
                            />
                            {frameDimensions.current.w > 0 && (
                              <CropOverlay
                                crop={pendingCrop}
                                onCropChange={setPendingCrop}
                                zoom={pView.zoom}
                              />
                            )}
                          </div>
                          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full font-mono">
                            <ChevronLeft
                              className="w-3 h-3 cursor-pointer"
                              onClick={() =>
                                setPreviewIndex(
                                  (p) => (p - 1 + activeFrames.length) % activeFrames.length,
                                )
                              }
                            />
                            {previewIndex + 1} / {activeFrames.length}
                            <ChevronRight
                              className="w-3 h-3 cursor-pointer"
                              onClick={() => setPreviewIndex((p) => (p + 1) % activeFrames.length)}
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
                          No frames
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
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
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

                {/* Sheet */}
                <Card
                  className={cn(
                    "md:col-span-1 shadow-lg ring-1 ring-primary/10",
                    allFrames.length === 0 && "opacity-50",
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
                        onClick={() => void compileSheet()}
                        disabled={allFrames.length === 0 || isCompiling}
                      >
                        {isCompiling ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3 h-3" />
                        )}
                        {isCompiling ? "Compiling..." : "Compile"}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control */}
                    <div
                      ref={sheetContainerRef}
                      className={cn(
                        "aspect-square rounded-lg border overflow-hidden relative cursor-move touch-none",
                        gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                      )}
                      onMouseDown={sheetViewport.startPanning}
                      onMouseMove={sheetViewport.updatePanning}
                      onMouseUp={sheetViewport.stopPanning}
                      onMouseLeave={sheetViewport.stopPanning}
                    >
                      {sheetPreviewUrl ? (
                        <div
                          className="absolute top-0 left-0"
                          style={{
                            width: sheetDimensions.current.w || undefined,
                            height: sheetDimensions.current.h || undefined,
                            transform: `translate(${sView.offset.x}px, ${sView.offset.y}px) scale(${sView.zoom})`,
                            transformOrigin: "0 0",
                          }}
                        >
                          <img
                            src={sheetPreviewUrl}
                            alt="Result"
                            className="block max-w-none"
                            style={{
                              width: sheetDimensions.current.w || undefined,
                              height: sheetDimensions.current.h || undefined,
                            }}
                            draggable={false}
                          />
                          {sheetDimensions.current.w > 0 && (
                            <CropOverlay
                              crop={pendingCrop}
                              onCropChange={setPendingCrop}
                              zoom={sView.zoom}
                              cellCols={sheetGrid.cols}
                              cellRows={sheetGrid.rows}
                            />
                          )}
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 opacity-20">
                          <ImageIcon className="w-12 h-12" />
                          <p className="text-sm font-medium">Spritesheet will appear here</p>
                        </div>
                      )}
                      <ZoomIndicator
                        zoom={sView.zoom}
                        baseZoom={sheetViewport.baseView.zoom}
                        className="absolute bottom-2 right-2"
                      />
                      {(cropDirty || !isCropEmpty(appliedCrop)) && (
                        <div className="absolute bottom-2 left-2 right-16 flex items-center gap-2 bg-black/75 backdrop-blur-sm text-white px-3 py-1.5 rounded-full text-xs">
                          <Crop className="w-3 h-3 text-primary-foreground" />
                          <span className="font-mono hidden sm:inline">
                            {cropDirty
                              ? `${(pendingCrop.top * 100).toFixed(0)}/${(pendingCrop.right * 100).toFixed(0)}/${(pendingCrop.bottom * 100).toFixed(0)}/${(pendingCrop.left * 100).toFixed(0)}%`
                              : "crop locked"}
                          </span>
                          <div className="flex-1" />
                          <Button
                            onClick={applyCrop}
                            disabled={!cropDirty || pipeline.state.running}
                            size="sm"
                            className="h-6 text-xs px-2"
                          >
                            {pipeline.state.running ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Apply"
                            )}
                          </Button>
                          <Button
                            onClick={resetCrop}
                            disabled={
                              (isCropEmpty(appliedCrop) && isCropEmpty(pendingCrop)) ||
                              pipeline.state.running
                            }
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs px-2 text-white hover:bg-white/20 hover:text-white"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Columns</Label>
                        <Input
                          type="number"
                          className="h-7 w-16 text-xs"
                          value={columns}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (n > 0) setColumns(n);
                          }}
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-lg ring-1 ring-primary/10">
                <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle>
                      Frame Selection ({selectedIndices.size || allFrames.length} /{" "}
                      {allFrames.length})
                    </CardTitle>
                    <CardDescription>Drag to toggle multiple frames.</CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="dedupe-tolerance" className="text-xs text-muted-foreground">
                        Tolerance
                      </Label>
                      <Input
                        id="dedupe-tolerance"
                        type="number"
                        min={0}
                        step={1}
                        className="h-8 w-16 text-xs"
                        title={DEDUPE_THRESHOLD_HELP}
                        value={dedupeTolerance}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n) && n >= 0) setDedupeTolerance(n);
                        }}
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => void selectUnique()}
                      disabled={allFrames.length === 0 || isFindingDuplicates}
                      title="Deselect frames that duplicate an earlier one"
                    >
                      {isFindingDuplicates && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                      Select unique
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => setSelectedIndices(new Set())}
                    >
                      Select All
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs"
                      onClick={() => setSelectedIndices(new Set(allFrames.map((_, i) => i)))}
                    >
                      Mark All
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-[10px] text-muted-foreground mb-2 leading-tight">
                    Tolerance: mean per-channel RGBA difference, 0–255. 0 = exact duplicates only.
                    {dedupeNoticeText && (
                      <span className="ml-1 font-medium text-foreground">{dedupeNoticeText}.</span>
                    )}
                  </p>
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-87.5 overflow-y-auto p-1 border rounded-md select-none">
                    {allFrames.map((frame, i) => (
                      <FrameItem
                        key={frame.id}
                        index={i}
                        frame={frame}
                        isSelected={selectedIndices.size === 0 || selectedIndices.has(i)}
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

      {pipeline.state.error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground px-4 py-2 rounded shadow-lg text-sm">
          {pipeline.state.error}
        </div>
      )}
    </main>
  );
}

// -----------------------------------------------------------------

export default function SpritesheetPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin mr-2" /> Loading Sheet Builder…
        </div>
      }
    >
      <SpritesheetContent />
    </Suspense>
  );
}
