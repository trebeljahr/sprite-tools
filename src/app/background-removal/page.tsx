"use client";

import {
  BackgroundRemovalSettings,
  type BackgroundRemovalState,
} from "@/components/background-removal-settings";
import {
  AsepriteSource,
  FrameImg,
  SheetSource,
  UploadZone,
  useAsepriteSource,
  VideoSource,
} from "@/components/pipeline-source";
import { SampleSprites } from "@/components/sample-sprites";
import { SourceBanner } from "@/components/source-banner";
import { ToolHeader } from "@/components/tool-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { useViewport } from "@/hooks/use-viewport";
import { track } from "@/lib/analytics";
import { exportAsZip, frameToPngBlob, stitchSheet } from "@/lib/pipeline/export";
import { detectSheetGrid, isAsepriteFilename } from "@/lib/pipeline/import";
import {
  type AutoCropConfig,
  type BackgroundMode,
  type ChromaKeyConfig,
  DEDUPE_THRESHOLD_HELP,
  type Frame,
} from "@/lib/pipeline/types";
import {
  buildAutoCropStep,
  buildChromaKeyStep,
  buildDedupeStep,
  buildImportAsepriteStep,
  buildImportFilesStep,
  buildImportSheetStep,
  buildImportVideoStep,
  usePipeline,
} from "@/lib/pipeline/use-pipeline";
import { useSharedProjectSource } from "@/lib/project/store";
import { cn } from "@/lib/utils";

import {
  Download,
  Eraser,
  FileImage,
  Grid3x3,
  Images,
  Layers,
  Loader2,
  Moon,
  Package,
  SquareSplitHorizontal,
  Sun,
  Video,
} from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type SourceTab = "video" | "sheet" | "images" | "aseprite";

const DEFAULT_SETTINGS: BackgroundRemovalState = {
  backgroundMode: "chroma-transparent",
  autoCrop: true,
  aspectRatio: "free",
  similarity: 30,
  softness: 10,
  spill: 20,
  choke: 1,
};

// The only two step configs this tool drives. Module-scope so the live-update
// effect below can build a comparison config without re-creating a closure
// on every render.
function chromaConfigFrom(br: BackgroundRemovalState): ChromaKeyConfig {
  return {
    mode: br.backgroundMode as BackgroundMode,
    similarity: br.similarity,
    softness: br.softness,
    spill: br.spill,
    choke: br.choke,
    autoDetermineFillColor: true,
  };
}

function autoCropConfigFrom(br: BackgroundRemovalState): AutoCropConfig {
  return { enabled: br.autoCrop, padding: 2, aspectRatio: br.aspectRatio };
}

// -----------------------------------------------------------------
// <SourceFrameView>: the "before" half of the compare view.
// -----------------------------------------------------------------
// Re-importing the source a second time just to show the original would
// double the work (a whole extra video decode). Instead we reconstruct the
// pre-chroma frame straight from the source asset using the metadata the
// importers already record: a timestamp for video, a grid cell for sheets,
// a filename for individual images.

interface SourceFrameViewProps {
  tab: SourceTab;
  frame: Frame | null;
  videoUrl: string | null;
  sheetUrl: string | null;
  sheetCols: number;
  sheetRows: number;
  /** Natural size of the sheet image; needed to letterbox a single cell. */
  sheetDims: { w: number; h: number } | null;
  imageUrlByName: Map<string, string>;
}

function SourceFrameView({
  tab,
  frame,
  videoUrl,
  sheetUrl,
  sheetCols,
  sheetRows,
  sheetDims,
  imageUrlByName,
}: SourceFrameViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timestamp = frame?.metadata?.timestamp;

  // Park the <video> on the exact frame the pipeline sampled.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || timestamp === undefined) return;
    const seek = () => {
      el.currentTime = timestamp;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener("loadedmetadata", seek, { once: true });
  }, [timestamp]);

  const empty = (
    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
      No source frame
    </div>
  );

  if (!frame) return empty;

  if (tab === "video") {
    if (!videoUrl) return empty;
    return (
      <video
        ref={videoRef}
        src={videoUrl}
        muted
        playsInline
        preload="metadata"
        className="absolute inset-0 w-full h-full object-contain"
      />
    );
  }

  if (tab === "sheet") {
    if (!sheetUrl || !sheetDims) return empty;
    const cellW = sheetDims.w / Math.max(1, sheetCols);
    const cellH = sheetDims.h / Math.max(1, sheetRows);
    const ratio = cellW / cellH;
    // The pane is square, so percentages of its width and height are the
    // same number of pixels — letterbox the cell by shrinking the long side.
    const box =
      ratio >= 1
        ? { width: "100%", height: `${100 / ratio}%` }
        : { height: "100%", width: `${100 * ratio}%` };
    const row = frame.metadata?.cellRow ?? 0;
    const col = frame.metadata?.cellCol ?? 0;
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative overflow-hidden" style={box}>
          <img
            src={sheetUrl}
            alt=""
            className="absolute max-w-none"
            style={{
              width: `${sheetCols * 100}%`,
              height: `${sheetRows * 100}%`,
              left: `${-col * 100}%`,
              top: `${-row * 100}%`,
            }}
          />
        </div>
      </div>
    );
  }

  // An .ase has no per-frame source image to show: the only "before" is the
  // composited frame, which the pipeline does not keep once it is keyed. Say
  // that instead of the generic empty state, which reads like a bug.
  if (tab === "aseprite") {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-muted-foreground text-xs">
        Aseprite frames are composited from layers, so there is no original image to show
      </div>
    );
  }

  const url = frame.metadata?.filename ? imageUrlByName.get(frame.metadata.filename) : undefined;
  if (!url) return empty;
  return <img src={url} alt="" className="absolute inset-0 w-full h-full object-contain" />;
}

// -----------------------------------------------------------------
// Page
// -----------------------------------------------------------------

export default function BackgroundRemovalPage() {
  const pipeline = usePipeline();
  // Sheet / single-image sources ride the shared project source so an upload
  // here shows up in every other tool (and vice versa). Videos stay local —
  // no other tool consumes them.
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();

  const [sourceTab, setSourceTab] = useState<SourceTab>("sheet");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fps, setFps] = useState(10);
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [sheetDims, setSheetDims] = useState<{ w: number; h: number } | null>(null);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  // Settings on this page are live, so the Aseprite picker is too: a layer,
  // tag or hidden-layer change re-runs the import that is on screen. Only
  // while the pipeline still holds this very file — a newly picked file waits
  // for Import Frames like every other source.
  const aseprite = useAsepriteSource({
    onConfigChange: (config, file) => {
      const step = pipeline.state.steps.find((s) => s.kind === "import-aseprite");
      if (!step || pipeline.state.source?.file !== file) return;
      pipeline.updateStep(step.id, { ...config, sourceName: file.name }, true);
    },
  });

  // Duplicate removal is a real pipeline step here — this page has no frame
  // grid to deselect things in, so the chain itself has to do the dropping.
  // Off by default: it costs a full read-back of every frame's pixels.
  const [dedupeEnabled, setDedupeEnabled] = useState(false);
  const [dedupeThreshold, setDedupeThreshold] = useState(0);
  const [appliedDedupeThreshold, setAppliedDedupeThreshold] = useState(0);

  const [brState, setBrState] = useState<BackgroundRemovalState>(DEFAULT_SETTINGS);
  // Debounced mirror of brState — sliders fire continuously while dragging
  // and every distinct value would kick off a full chroma pass.
  const [appliedBr, setAppliedBr] = useState<BackgroundRemovalState>(DEFAULT_SETTINGS);

  const [ranTab, setRanTab] = useState<SourceTab | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [compare, setCompare] = useState(false);
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);
  const [columns, setColumns] = useState(8);
  const [isExporting, setIsExporting] = useState(false);

  const previewViewport = useViewport();
  const { view: pView, containerRef: previewContainerRef } = previewViewport;
  const frameDims = useRef({ w: 0, h: 0 });
  const hasAutoFitted = useRef(false);

  const output = pipeline.state.output;
  const frames = useMemo(() => output?.frames ?? [], [output]);
  const activeFrame = frames[selectedIndex] ?? null;

  // ------- Object-URL lifecycles -------

  useEffect(() => {
    if (!videoFile) {
      setVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const imageUrls = useMemo(() => imageFiles.map((f) => URL.createObjectURL(f)), [imageFiles]);
  useEffect(() => {
    return () => {
      for (const u of imageUrls) URL.revokeObjectURL(u);
    };
  }, [imageUrls]);

  // importFromFiles sorts by filename and stamps each frame with it, so the
  // compare view looks the original back up by name rather than by index.
  const imageUrlByName = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = 0; i < imageFiles.length; i++) map.set(imageFiles[i].name, imageUrls[i]);
    return map;
  }, [imageFiles, imageUrls]);

  // Natural sheet size — the compare view needs the cell aspect ratio.
  useEffect(() => {
    if (!sourceUrl) {
      setSheetDims(null);
      return;
    }
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active) setSheetDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = sourceUrl;
    return () => {
      active = false;
    };
  }, [sourceUrl]);

  // A sheet arriving from the shared store — uploaded here, loaded as a
  // sample, or handed over by another tool — gets its grid guessed once.
  useEffect(() => {
    if (!sourceFile) {
      setDetectedGrid(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const det = await detectSheetGrid(sourceFile);
        if (!active || det.confidence <= 0) return;
        setDetectedGrid({ cols: det.cols, rows: det.rows });
        setSheetCols(det.cols);
        setSheetRows(det.rows);
      } catch {
        // Silent — the user can still type the grid in by hand.
      }
    })();
    return () => {
      active = false;
    };
  }, [sourceFile]);

  // ------- Source handlers -------

  const handleVideoFile = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) {
      toast.error("Unsupported file type. Please upload a video.");
      return;
    }
    setVideoFile(file);
  }, []);

  const handleAsepriteFile = useCallback(
    (file: File) => {
      if (!isAsepriteFilename(file.name)) {
        toast.error("Unsupported file type. Please upload a .ase or .aseprite file.");
        return;
      }
      aseprite.pick(file);
    },
    // `aseprite` is a fresh object every render; `pick` is the stable callback.
    [aseprite.pick],
  );

  const handleSheetFile = useCallback(
    (file: File) => {
      // Extension, not MIME: browsers report an empty `type` for .ase files, so
      // the image guard below would reject one with a misleading message.
      if (isAsepriteFilename(file.name)) {
        setSourceTab("aseprite");
        aseprite.pick(file);
        return;
      }
      if (!file.type.startsWith("image/")) {
        toast.error("Unsupported file type. Please upload an image.");
        return;
      }
      void setSharedSource(file);
    },
    [setSharedSource, aseprite.pick],
  );

  const handleImageFiles = useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    // .ase files have no image MIME type, so the filter above drops them;
    // say so rather than losing them without a word.
    const skippedAse = files.filter((f) => isAsepriteFilename(f.name)).length;
    if (images.length === 0) {
      toast.error(
        skippedAse > 0
          ? "Aseprite files import from the Aseprite tab."
          : "No image files in that selection.",
      );
      return;
    }
    if (skippedAse > 0) {
      toast.warning(
        `Skipped ${skippedAse} Aseprite file${skippedAse === 1 ? "" : "s"}; import ${skippedAse === 1 ? "it" : "them"} from the Aseprite tab.`,
      );
    }
    setImageFiles(images);
  }, []);

  // Drops and pastes route themselves: a video opens the Video tab, several
  // images open the Images tab, one image opens the Sheet tab.
  const handleIncomingFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length > 1) {
        setSourceTab("images");
        handleImageFiles(files);
        return;
      }
      const file = files[0];
      if (isAsepriteFilename(file.name)) {
        setSourceTab("aseprite");
        handleAsepriteFile(file);
        return;
      }
      if (file.type.startsWith("video/")) {
        setSourceTab("video");
        handleVideoFile(file);
        return;
      }
      if (file.type.startsWith("image/")) {
        setSourceTab("sheet");
        handleSheetFile(file);
        return;
      }
      toast.error("Unsupported file type.");
    },
    [handleVideoFile, handleSheetFile, handleAsepriteFile, handleImageFiles],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items.map((i) => i.getAsFile()).filter((f): f is File => f !== null);
      if (files.length) handleIncomingFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleIncomingFiles]);

  const uploadZoneProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    },
    onDragLeave: () => setIsDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleIncomingFiles(Array.from(e.dataTransfer.files ?? []));
    },
  };

  // ------- Pipeline kickoff -------

  const runFromSource = (tab: SourceTab) => {
    const chroma = buildChromaKeyStep(chromaConfigFrom(brState));
    const crop = buildAutoCropStep(autoCropConfigFrom(brState));
    // Dedupe runs last: cropping first lines the sprites up, so two takes of
    // the same pose compare as the same pixels rather than as shifted ones.
    const tail = dedupeEnabled ? [crop, buildDedupeStep({ threshold: dedupeThreshold })] : [crop];
    if (tab === "video") {
      if (!videoFile) return;
      pipeline.setSource({ file: videoFile });
      pipeline.setSteps([buildImportVideoStep({ fps }, videoFile.name), chroma, ...tail], false);
    } else if (tab === "sheet") {
      if (!sourceFile) return;
      pipeline.setSource({ file: sourceFile });
      pipeline.setSteps(
        [
          buildImportSheetStep({ cols: sheetCols, rows: sheetRows }, sourceFile.name),
          chroma,
          ...tail,
        ],
        false,
      );
    } else if (tab === "aseprite") {
      if (!aseprite.file) return;
      pipeline.setSource({ file: aseprite.file });
      pipeline.setSteps(
        [buildImportAsepriteStep(aseprite.config, aseprite.file.name), chroma, ...tail],
        false,
      );
    } else if (tab === "images") {
      if (imageFiles.length === 0) return;
      pipeline.setSource({ images: imageFiles });
      pipeline.setSteps([buildImportFilesStep(imageFiles.length), chroma, ...tail], false);
    }
    setAppliedBr(brState);
    setAppliedDedupeThreshold(dedupeThreshold);
    setRanTab(tab);
    setSelectedIndex(0);
    hasAutoFitted.current = false;
  };

  // Settings are live. Debounce first, then push the new config into the
  // steps that already exist so the hook's step cache re-runs only what
  // actually changed (an auto-crop tweak never re-runs the chroma pass).
  useEffect(() => {
    const t = setTimeout(() => setAppliedBr(brState), 180);
    return () => clearTimeout(t);
  }, [brState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pipeline` is a fresh object every render; the JSON guard below makes re-entry a no-op
  useEffect(() => {
    const chromaStep = pipeline.state.steps.find((s) => s.kind === "chroma-key");
    const cropStep = pipeline.state.steps.find((s) => s.kind === "auto-crop");
    if (!chromaStep || !cropStep) return;
    const chromaCfg = chromaConfigFrom(appliedBr);
    const cropCfg = autoCropConfigFrom(appliedBr);
    // Guard on serialized equality: updateStep always hands back a fresh
    // steps array, so an unguarded call here would re-trigger this effect
    // forever.
    if (JSON.stringify(chromaStep.config) !== JSON.stringify(chromaCfg)) {
      pipeline.updateStep(chromaStep.id, chromaCfg, true);
    }
    if (JSON.stringify(cropStep.config) !== JSON.stringify(cropCfg)) {
      pipeline.updateStep(cropStep.id, cropCfg, true);
    }
  }, [appliedBr, pipeline.state.steps]);

  // Same debounce for the tolerance box — every keystroke would otherwise
  // re-read the pixels of every frame.
  useEffect(() => {
    const t = setTimeout(() => setAppliedDedupeThreshold(dedupeThreshold), 250);
    return () => clearTimeout(t);
  }, [dedupeThreshold]);

  // The dedupe step is added and removed rather than left in place disabled,
  // so turning it off costs nothing at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pipeline` is a fresh object every render; the presence/JSON guards below make re-entry a no-op
  useEffect(() => {
    const steps = pipeline.state.steps;
    if (steps.length === 0) return;
    const existing = steps.find((s) => s.kind === "dedupe");
    if (!dedupeEnabled) {
      if (existing) pipeline.removeStep(existing.id, false);
      return;
    }
    const cfg = { threshold: appliedDedupeThreshold };
    if (!existing) {
      pipeline.setSteps([...steps, buildDedupeStep(cfg)], false);
      return;
    }
    if (JSON.stringify(existing.config) !== JSON.stringify(cfg)) {
      pipeline.updateStep(existing.id, cfg, false);
    }
  }, [dedupeEnabled, appliedDedupeThreshold, pipeline.state.steps]);

  // How many frames the dedupe step actually dropped on the last run.
  const dedupeStepId = pipeline.state.steps.find((s) => s.kind === "dedupe")?.id;
  const dedupeCounts = dedupeStepId ? pipeline.state.stepFrameCounts[dedupeStepId] : undefined;
  const dedupeRemoved = dedupeCounts ? dedupeCounts.input - dedupeCounts.output : 0;

  // ------- Preview bookkeeping -------

  useEffect(() => {
    if (frames.length === 0 || !output) return;
    frameDims.current = { w: output.stats.width, h: output.stats.height };
    hasAutoFitted.current = false;
    setColumns((prev) => (prev === 8 ? Math.max(1, Math.ceil(Math.sqrt(frames.length))) : prev));
  }, [output, frames.length]);

  // Keyed on `output` rather than the frame count so a re-run that changes
  // the frame size (an auto-crop toggle, say) refits instead of keeping the
  // zoom that suited the old dimensions.
  useEffect(() => {
    if (!output || output.frames.length === 0 || hasAutoFitted.current) return;
    if (!previewContainerRef.current || output.stats.width === 0) return;
    const { width, height } = output.stats;
    const raf = requestAnimationFrame(() => {
      previewViewport.fitToView(width, height);
      hasAutoFitted.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [output, previewContainerRef, previewViewport.fitToView]);

  if (frames.length > 0 && selectedIndex >= frames.length) setSelectedIndex(0);

  // ------- Export -------

  const download = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportZip = async () => {
    if (!output || frames.length === 0) return;
    setIsExporting(true);
    try {
      download(await exportAsZip(output), "background-removed.zip");
      track("export", { tool: "background-removal", format: "zip", frames: frames.length });
      toast.success(`Exported ${frames.length} PNGs as ZIP`);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportSheet = async () => {
    if (!output || frames.length === 0) return;
    setIsExporting(true);
    try {
      const { blob } = await stitchSheet(output, { columns: Math.max(1, columns) });
      download(blob, "background-removed-sheet.png");
      track("export", { tool: "background-removal", format: "sheet", frames: frames.length });
      toast.success("Sheet downloaded");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportSinglePng = async () => {
    if (!activeFrame) return;
    setIsExporting(true);
    try {
      download(await frameToPngBlob(activeFrame), "background-removed.png");
      track("export", { tool: "background-removal", format: "png", frames: 1 });
      toast.success("PNG downloaded");
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExporting(false);
    }
  };

  // ------- Render -------

  const running = pipeline.state.running;
  const progressLabel = pipeline.state.progress?.step ?? "";
  const progressPct = pipeline.state.progress
    ? Math.round(
        (pipeline.state.progress.current / Math.max(1, pipeline.state.progress.total)) * 100,
      )
    : 0;
  const checker = gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark";
  const compareTab = ranTab ?? sourceTab;

  return (
    <main className="flex-1 container max-w-7xl mx-auto py-8 px-4">
      <ToolHeader
        title="Background Removal"
        description="Chroma-key the background out of a video, a sprite sheet, an Aseprite file, or a pile of images — then crop and export."
        icon={Eraser}
        category="extract"
        docs="background-removal"
      />

      <SourceBanner onReplace={() => setSourceTab("sheet")} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left column: source, settings, export */}
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                A video, a sprite sheet, an .ase/.aseprite file, or individual images.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-muted/30 border">
                {(
                  [
                    { id: "video" as const, label: "Video", Icon: Video },
                    { id: "sheet" as const, label: "Sheet", Icon: Grid3x3 },
                    { id: "images" as const, label: "Images", Icon: Images },
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
                  running={running}
                  progressLabel={progressLabel}
                  progressPct={progressPct}
                />
              )}

              {sourceTab === "sheet" && (
                <>
                  <SheetSource
                    sheetUrl={sourceUrl}
                    cols={sheetCols}
                    rows={sheetRows}
                    setCols={setSheetCols}
                    setRows={setSheetRows}
                    detected={detectedGrid}
                    uploadZoneProps={uploadZoneProps}
                    isDragging={isDragging}
                    onFile={handleSheetFile}
                    onRun={() => runFromSource("sheet")}
                    running={running}
                    progressLabel={progressLabel}
                    progressPct={progressPct}
                  />
                  <SampleSprites />
                </>
              )}

              {sourceTab === "images" && (
                <div className="space-y-4">
                  <UploadZone
                    isDragging={isDragging}
                    hasFile={imageFiles.length > 0}
                    uploadZoneProps={uploadZoneProps}
                    accept="image/*"
                    multiple
                    onChange={handleImageFiles}
                  >
                    {imageFiles.length > 0 ? (
                      <div className="w-full h-full grid grid-cols-4 gap-1 p-2 overflow-hidden">
                        {imageUrls.slice(0, 12).map((url) => (
                          <img
                            key={url}
                            src={url}
                            alt=""
                            className="w-full h-full object-contain min-h-0"
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="text-center">
                        <Images className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
                        <p className="text-sm text-muted-foreground">
                          Upload / drop / paste image files
                        </p>
                      </div>
                    )}
                  </UploadZone>
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <FileImage className="w-3 h-3" />
                    {imageFiles.length} selected · imported in filename order
                  </p>
                  <Button
                    onClick={() => runFromSource("images")}
                    disabled={running || imageFiles.length === 0}
                    className="w-full"
                  >
                    {running ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Images className="mr-2 h-4 w-4" />
                    )}
                    Load Images
                  </Button>
                  {running && progressLabel && (
                    <div className="space-y-2 pt-2">
                      <div className="flex justify-between text-xs font-medium uppercase tracking-wider">
                        <span className="text-muted-foreground">{progressLabel}</span>
                        <span className="text-muted-foreground">{progressPct}%</span>
                      </div>
                      <Progress value={progressPct} className="h-1.5" />
                    </div>
                  )}
                </div>
              )}

              {sourceTab === "aseprite" && (
                <AsepriteSource
                  state={aseprite}
                  uploadZoneProps={uploadZoneProps}
                  isDragging={isDragging}
                  onFile={handleAsepriteFile}
                  onRun={() => runFromSource("aseprite")}
                  running={running}
                  progressLabel={progressLabel}
                  progressPct={progressPct}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Background Removal</CardTitle>
              <CardDescription className="text-xs">
                Changes re-run the pipeline as you make them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BackgroundRemovalSettings state={brState} setState={setBrState} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Duplicate Frames</CardTitle>
              <CardDescription className="text-xs">
                Fixed-FPS extraction and AI generation repeat the same pose. Drop the repeats before
                export.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Remove duplicates</Label>
                <Switch checked={dedupeEnabled} onCheckedChange={setDedupeEnabled} />
              </div>

              {dedupeEnabled && (
                <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="dedupe-tolerance" className="text-xs">
                      Tolerance
                    </Label>
                    <Input
                      id="dedupe-tolerance"
                      type="number"
                      min={0}
                      step={1}
                      value={dedupeThreshold}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n >= 0) setDedupeThreshold(n);
                      }}
                      className="h-9 w-24 text-sm"
                      title={DEDUPE_THRESHOLD_HELP}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Mean per-channel RGBA difference, 0–255. 0 = exact duplicates only.
                  </p>
                  {dedupeCounts && (
                    // Counts come from the last *completed* run; dim them while a
                    // re-run is in flight so a stale number doesn't read as final.
                    <p className={cn("text-xs font-medium", running && "opacity-50")}>
                      {dedupeRemoved > 0
                        ? `${dedupeRemoved} duplicate frame${dedupeRemoved === 1 ? "" : "s"} removed · ${dedupeCounts.output} left`
                        : "No duplicates found"}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Export</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={() => void exportZip()}
                disabled={isExporting || frames.length === 0}
                className="w-full"
              >
                {isExporting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Package className="mr-2 h-4 w-4" />
                )}
                Download PNGs (ZIP)
              </Button>
              <div className="flex items-end gap-2">
                <div className="space-y-1 w-24">
                  <Label className="text-xs">Columns</Label>
                  <Input
                    type="number"
                    min={1}
                    value={columns}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (n > 0) setColumns(n);
                    }}
                    className="h-9 text-sm"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() => void exportSheet()}
                  disabled={isExporting || frames.length === 0}
                  className="flex-1"
                >
                  <Layers className="mr-2 h-4 w-4" />
                  Download sheet (PNG)
                </Button>
              </div>
              {frames.length === 1 && (
                <Button
                  variant="outline"
                  onClick={() => void exportSinglePng()}
                  disabled={isExporting}
                  className="w-full"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download PNG
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: preview */}
        <div className="lg:col-span-8 space-y-6">
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Result</CardTitle>
                <CardDescription className="text-xs">
                  {frames.length > 0
                    ? `${frames.length} frame${frames.length === 1 ? "" : "s"} · ${output?.stats.width}×${output?.stats.height}`
                    : "Pick a source and run it to see the cutout."}
                </CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={compare ? "default" : "outline"}
                  className="h-8 gap-1.5"
                  onClick={() => setCompare((c) => !c)}
                  disabled={frames.length === 0}
                  title="Show the original next to the result"
                >
                  <SquareSplitHorizontal className="w-3.5 h-3.5" /> Compare
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setGridTheme((t) => (t === "light" ? "dark" : "light"))}
                  title="Toggle checkerboard contrast"
                >
                  {gridTheme === "light" ? (
                    <Moon className="w-4 h-4" />
                  ) : (
                    <Sun className="w-4 h-4" />
                  )}
                </Button>
                {!compare && (
                  <ViewportControls
                    onZoomIn={() =>
                      previewViewport.setZoomIn(frameDims.current.w, frameDims.current.h)
                    }
                    onZoomOut={() =>
                      previewViewport.setZoomOut(frameDims.current.w, frameDims.current.h)
                    }
                    onReset={() =>
                      previewViewport.fitToView(frameDims.current.w, frameDims.current.h)
                    }
                  />
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {running && progressLabel && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-medium uppercase tracking-wider">
                    <span className="text-muted-foreground">{progressLabel}</span>
                    <span className="text-muted-foreground">{progressPct}%</span>
                  </div>
                  <Progress value={progressPct} className="h-1.5" />
                </div>
              )}

              {pipeline.state.error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {pipeline.state.error}
                </div>
              )}

              {compare ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                      Before
                    </p>
                    <div className={cn("aspect-square rounded-lg border relative", checker)}>
                      <SourceFrameView
                        tab={compareTab}
                        frame={activeFrame}
                        videoUrl={videoUrl}
                        sheetUrl={sourceUrl}
                        sheetCols={sheetCols}
                        sheetRows={sheetRows}
                        sheetDims={sheetDims}
                        imageUrlByName={imageUrlByName}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                      After
                    </p>
                    <div className={cn("aspect-square rounded-lg border relative", checker)}>
                      {activeFrame && (
                        <FrameImg
                          frame={activeFrame}
                          className="absolute inset-0 w-full h-full object-contain"
                          draggable={false}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                // biome-ignore lint/a11y/noStaticElementInteractions: container intercepts pan events; not a control
                <div
                  ref={previewContainerRef}
                  className={cn(
                    "aspect-video rounded-lg border overflow-hidden relative cursor-move touch-none",
                    checker,
                  )}
                  onMouseDown={previewViewport.startPanning}
                  onMouseMove={previewViewport.updatePanning}
                  onMouseUp={previewViewport.stopPanning}
                  onMouseLeave={previewViewport.stopPanning}
                >
                  {activeFrame ? (
                    <>
                      <div
                        className="absolute top-0 left-0"
                        style={{
                          width: frameDims.current.w || undefined,
                          height: frameDims.current.h || undefined,
                          transform: `translate(${pView.offset.x}px, ${pView.offset.y}px) scale(${pView.zoom})`,
                          transformOrigin: "0 0",
                        }}
                      >
                        <FrameImg
                          frame={activeFrame}
                          className="block max-w-none"
                          style={{
                            width: frameDims.current.w || undefined,
                            height: frameDims.current.h || undefined,
                          }}
                          draggable={false}
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
                      No frames yet
                    </div>
                  )}
                </div>
              )}

              {frames.length > 1 && (
                <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-10 gap-2 max-h-72 overflow-y-auto pr-1">
                  {frames.map((frame, i) => (
                    <button
                      type="button"
                      key={frame.id}
                      onClick={() => setSelectedIndex(i)}
                      className={cn(
                        "aspect-square border rounded overflow-hidden relative transition-all",
                        checker,
                        i === selectedIndex ? "ring-2 ring-primary" : "hover:ring-1 ring-border",
                      )}
                      title={`Frame ${i + 1}`}
                    >
                      <FrameImg
                        frame={frame}
                        className="w-full h-full object-contain pointer-events-none"
                      />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
