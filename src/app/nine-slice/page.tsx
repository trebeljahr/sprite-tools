"use client";

import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Frame as FrameIcon,
  Grid3x3,
  ImageIcon,
  Loader2,
  Palette,
  Scan,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import {
  clampInsets,
  DEFAULT_ALPHA_THRESHOLD,
  DEFAULT_MIN_MIDDLE,
  DEFAULT_TOLERANCE,
  detectNineSlice,
  nineSliceRegions,
  stretchNineSlice,
  type NineSliceInsets,
} from "@/lib/nine-slice/nine-slice";
import { decodeNinePatch, encodeNinePatch, isNinePatchCandidate } from "@/lib/nine-slice/ninepatch";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";

interface NineSliceFrame {
  index: number;
  width: number;
  height: number;
  cellRow?: number;
  cellCol?: number;
  imageData: ImageData;
}

type Side = "left" | "right" | "top" | "bottom";

const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];

type ManualSides = Record<Side, boolean>;

const NO_MANUAL: ManualSides = { left: false, right: false, top: false, bottom: false };

interface FrameInsets {
  insets: NineSliceInsets;
  /** Sides the user set by hand — a dragged guide or a typed number. */
  manual: ManualSides;
  /** True when the variance-profile guess supplied the insets. False for a
   *  decoded .9.png border, which is exact rather than guessed. */
  fromGuess: boolean;
  confidence: number;
}

type SourceMode = "single" | "sheet";

// Same header + `nineSlice` payload as `sprite-tools nine-slice` so a web
// export and a CLI export merge with `jq -s add`.
interface NineSliceOutput {
  source: string;
  frameWidth: number;
  frameHeight: number;
  grid: { cols: number; rows: number; detected: boolean };
  options: {
    auto: boolean;
    explicit: Partial<NineSliceInsets> | null;
    alphaThreshold: number;
    tolerance: number;
    minMiddle: number;
    ninePatch?: boolean;
  };
  nineSlice: Array<{
    index: number;
    cell: { row: number; col: number };
    insets: NineSliceInsets;
    detected: boolean;
    confidence: number;
    regions: Array<{
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      stretchX: boolean;
      stretchY: boolean;
    }>;
  }>;
}

// Constant on-screen sizes for the guides. Divided by zoom so a transformed
// parent doesn't shrink or grow them — same idiom as <CropOverlay>.
const SCREEN_GUIDE_HIT_PX = 22;
const SCREEN_GUIDE_LINE_PX = 2;

async function frameToImageData(frame: Frame): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  return ctx.getImageData(0, 0, frame.width, frame.height);
}

function imageDataToBlob(img: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

interface GuessOptions {
  alphaThreshold: number;
  tolerance: number;
  minMiddle: number;
}

/**
 * Re-derive every entry against new guess options, the way the CLI resolves
 * one run: sides set by hand win, guessed entries re-guess their remaining
 * sides, and everything is clamped to the minimum middle. Keeps the exported
 * `options` truthful about how the insets were produced.
 */
function reresolve(
  entries: FrameInsets[],
  frames: NineSliceFrame[],
  opts: GuessOptions,
): FrameInsets[] {
  return entries.map((entry, i) => {
    const f = frames[i];
    if (!f) return entry;
    const d =
      entry.fromGuess && SIDES.some((s) => !entry.manual[s])
        ? detectNineSlice(f.imageData, opts)
        : null;
    const merged = { ...entry.insets };
    if (d) {
      for (const side of SIDES) {
        if (!entry.manual[side]) merged[side] = d.insets[side];
      }
    }
    return {
      insets: clampInsets(merged, f.width, f.height, opts.minMiddle),
      manual: entry.manual,
      fromGuess: entry.fromGuess,
      confidence: d ? d.confidence : entry.confidence,
    };
  });
}

/** All four sides typed in by hand ⇒ nothing was left to the guess. */
function isGuessed(entry: FrameInsets): boolean {
  return entry.fromGuess && SIDES.some((s) => !entry.manual[s]);
}

function explicitFrom(entry: FrameInsets): Partial<NineSliceInsets> | null {
  const out: Partial<NineSliceInsets> = {};
  for (const side of SIDES) {
    if (entry.manual[side]) out[side] = entry.insets[side];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// -------------------------------------------------------------------
// Guide overlay — four draggable lines over the sprite, plus the nine
// regions tinted by which axes they stretch along.
// -------------------------------------------------------------------
interface GuideOverlayProps {
  width: number;
  height: number;
  insets: NineSliceInsets;
  zoom: number;
  onGuideDrag: (side: Side, value: number, base: NineSliceInsets) => void;
}

function GuideOverlay({ width, height, insets, zoom, onGuideDrag }: GuideOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const regions = nineSliceRegions(insets, width, height);
  const z = Math.max(zoom, 0.01);
  // Capped at a third of the axis so the four grab zones can't swallow each
  // other on a small sprite viewed at a low zoom.
  const hitX = Math.min(SCREEN_GUIDE_HIT_PX / z, Math.max(1, width / 3));
  const hitY = Math.min(SCREEN_GUIDE_HIT_PX / z, Math.max(1, height / 3));
  const line = SCREEN_GUIDE_LINE_PX / z;

  const startDrag = (e: React.PointerEvent, side: Side) => {
    e.stopPropagation();
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const pxPerX = rect.width / Math.max(1, width);
    const pxPerY = rect.height / Math.max(1, height);
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...insets };

    (e.target as Element).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / pxPerX;
      const dy = (ev.clientY - startY) / pxPerY;
      // Right and bottom insets grow towards the opposite edge, so the drag
      // delta is inverted for them.
      const delta = side === "left" ? dx : side === "right" ? -dx : side === "top" ? dy : -dy;
      onGuideDrag(side, Math.round(base[side] + delta), base);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const guides: Array<{ side: Side; axis: "x" | "y"; pos: number }> = [
    { side: "left", axis: "x", pos: insets.left },
    { side: "right", axis: "x", pos: width - insets.right },
    { side: "top", axis: "y", pos: insets.top },
    { side: "bottom", axis: "y", pos: height - insets.bottom },
  ];

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none">
      {regions.map((r) => (
        <div
          key={r.name}
          className={cn(
            "absolute",
            r.stretchX && r.stretchY && "bg-emerald-400/25",
            r.stretchX && !r.stretchY && "bg-sky-400/25",
            !r.stretchX && r.stretchY && "bg-amber-400/25",
            !r.stretchX && !r.stretchY && "bg-slate-900/10",
          )}
          style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
        />
      ))}

      {guides.map(({ side, axis, pos }) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag handle; the numeric inputs are the keyboard-accessible path
        <div
          key={side}
          onPointerDown={(e) => startDrag(e, side)}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute pointer-events-auto flex items-center justify-center",
            axis === "x" ? "cursor-col-resize" : "cursor-row-resize",
          )}
          style={
            axis === "x"
              ? { left: pos - hitX / 2, top: 0, width: hitX, height: "100%" }
              : { top: pos - hitY / 2, left: 0, height: hitY, width: "100%" }
          }
          title={`Drag to set the ${side} inset`}
        >
          <div
            className="bg-primary shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
            style={axis === "x" ? { width: line, height: "100%" } : { height: line, width: "100%" }}
          />
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------
// One stretched preview at a fixed target size.
// -------------------------------------------------------------------
interface StretchPreviewProps {
  image: ImageData;
  insets: NineSliceInsets;
  targetWidth: number;
  targetHeight: number;
  label: string;
  maxHeight?: number;
  gridTheme: "light" | "dark";
}

function StretchPreview({
  image,
  insets,
  targetWidth,
  targetHeight,
  label,
  maxHeight = 150,
  gridTheme,
}: StretchPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // stretchNineSlice throws below the fixed corner budget, so clamp up to it
  // here and tell the user rather than letting the throw surface.
  const minW = insets.left + insets.right;
  const minH = insets.top + insets.bottom;
  const w = Math.max(1, targetWidth, minW);
  const h = Math.max(1, targetHeight, minH);
  const clamped = w !== targetWidth || h !== targetHeight;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const out = stretchNineSlice(image, insets, w, h);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);
      ctx.putImageData(out, 0, 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [image, insets, w, h]);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground">
          {w}×{h}
        </span>
      </div>
      <div
        className={cn(
          "rounded-md border overflow-hidden flex items-center justify-center p-2",
          gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
        )}
        style={{ minHeight: 64 }}
      >
        {/* The canvas stays mounted even while `error` is set — unmounting it
            would drop the ref and leave the effect unable to clear the error. */}
        <canvas
          ref={canvasRef}
          className={cn("block", error && "hidden")}
          style={{
            imageRendering: "pixelated",
            maxWidth: "100%",
            maxHeight,
            width: "auto",
            height: "auto",
          }}
        />
        {error && <p className="text-[10px] text-destructive px-2 py-4 text-center">{error}</p>}
      </div>
      {clamped && (
        <p className="text-[10px] text-amber-600 dark:text-amber-500">
          Clamped up to {w}×{h} — the fixed corners already need {minW}×{minH}px.
        </p>
      )}
    </div>
  );
}

export default function NineSlicePage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<NineSliceFrame[]>([]);
  const [entries, setEntries] = useState<FrameInsets[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDownloaded, setHasDownloaded] = useState(false);

  const [lockAll, setLockAll] = useState(false); // apply every guide change to all frames
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Guess options — the same knobs the CLI exposes.
  const [alphaThreshold, setAlphaThreshold] = useState(DEFAULT_ALPHA_THRESHOLD);
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [minMiddle, setMinMiddle] = useState(DEFAULT_MIN_MIDDLE);
  // Mirror of the three knobs for the load-time seed, which must not re-run
  // (and re-slice the source) every time a slider moves.
  const guessOptsRef = useRef<GuessOptions>({
    alphaThreshold: DEFAULT_ALPHA_THRESHOLD,
    tolerance: DEFAULT_TOLERANCE,
    minMiddle: DEFAULT_MIN_MIDDLE,
  });

  // .9.png border that the user decoded, if any.
  const [ninePatchApplied, setNinePatchApplied] = useState(false);
  const [ninePatchPadding, setNinePatchPadding] = useState<NineSliceInsets | null>(null);

  const [customSize, setCustomSize] = useState<{ w: number; h: number } | null>(null);

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
  // Slice + seed each frame with a first guess
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!sourceFile) {
      setFrames([]);
      setEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsProcessing(true);
      setError(null);
      setNinePatchApplied(false);
      setNinePatchPadding(null);
      setCustomSize(null);
      try {
        const sliced = await importFromSpriteSheet(sourceFile, {
          cols: effectiveCols,
          rows: effectiveRows,
        });
        if (cancelled) return;
        const out: NineSliceFrame[] = [];
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
        // Seed the guides with the variance-profile guess so the stretch
        // previews show something on load, using whatever the sliders say.
        const seedOpts = guessOptsRef.current;
        setEntries(
          out.map((f) => {
            const d = detectNineSlice(f.imageData, seedOpts);
            return {
              insets: d.insets,
              manual: { ...NO_MANUAL },
              fromGuess: true,
              confidence: d.confidence,
            };
          }),
        );
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

  const currentFrame = frames[currentIndex];
  const currentEntry = entries[currentIndex];
  const insets = currentEntry?.insets ?? { left: 0, right: 0, top: 0, bottom: 0 };

  // -----------------------------------------------------------------
  // Canvas — the sprite itself; the guides live in a DOM overlay on top
  // -----------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentFrame) return;
    canvas.width = currentFrame.width;
    canvas.height = currentFrame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(currentFrame.imageData, 0, 0);
  }, [currentFrame]);

  // -----------------------------------------------------------------
  // Inset editing — clampInsets from the core is the only authority on
  // what a legal inset set is, in both the drag and the number path.
  // -----------------------------------------------------------------
  const setInset = useCallback(
    (side: Side, value: number, base?: NineSliceInsets) => {
      setEntries((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const applyTo = (i: number) => {
          const f = frames[i];
          const entry = prev[i];
          if (!f || !entry) return;
          const from = base && i === currentIndex ? base : entry.insets;
          next[i] = {
            insets: clampInsets({ ...from, [side]: value }, f.width, f.height, minMiddle),
            manual: { ...entry.manual, [side]: true },
            fromGuess: entry.fromGuess,
            confidence: entry.confidence,
          };
        };
        if (lockAll) {
          for (let i = 0; i < next.length; i++) applyTo(i);
        } else {
          applyTo(currentIndex);
        }
        return next;
      });
    },
    [frames, currentIndex, lockAll, minMiddle],
  );

  const updateGuessOptions = (patch: Partial<GuessOptions>) => {
    const opts = { alphaThreshold, tolerance, minMiddle, ...patch };
    guessOptsRef.current = opts;
    setAlphaThreshold(opts.alphaThreshold);
    setTolerance(opts.tolerance);
    setMinMiddle(opts.minMiddle);
    setEntries((prev) => reresolve(prev, frames, opts));
  };

  const runGuess = useCallback(
    (scope: "current" | "all") => {
      if (frames.length === 0) return;
      const opts = { alphaThreshold, tolerance, minMiddle };
      const targets = scope === "all" ? frames.map((_, i) => i) : [currentIndex];
      const results = targets.map((i) => ({ i, d: detectNineSlice(frames[i].imageData, opts) }));
      setEntries((prev) => {
        const next = [...prev];
        for (const { i, d } of results) {
          next[i] = {
            insets: d.insets,
            manual: { ...NO_MANUAL },
            fromGuess: true,
            confidence: d.confidence,
          };
        }
        return next;
      });
      const shown = results.find((r) => r.i === currentIndex) ?? results[0];
      toast.success(
        `Guessed ${shown.d.insets.left}/${shown.d.insets.right}/${shown.d.insets.top}/${shown.d.insets.bottom} at ${Math.round(shown.d.confidence * 100)}% — check the guides.`,
      );
    },
    [frames, currentIndex, alphaThreshold, tolerance, minMiddle],
  );

  const copyInsetsToAll = () => {
    if (!currentEntry) return;
    setEntries((prev) =>
      prev.map((entry, i) => {
        const f = frames[i];
        if (!f) return entry;
        return {
          insets: clampInsets(currentEntry.insets, f.width, f.height, minMiddle),
          manual: { ...currentEntry.manual },
          fromGuess: currentEntry.fromGuess,
          confidence: currentEntry.confidence,
        };
      }),
    );
    toast.success("Copied insets to all frames");
  };

  // -----------------------------------------------------------------
  // Android .9.png import
  // -----------------------------------------------------------------
  const ninePatchOffer = useMemo(() => {
    if (ninePatchApplied || frames.length !== 1) return false;
    const f = frames[0];
    return f ? isNinePatchCandidate(f.imageData) : false;
  }, [frames, ninePatchApplied]);

  const applyNinePatch = () => {
    const f = frames[0];
    if (!f) return;
    try {
      const res = decodeNinePatch(f.imageData);
      setFrames([
        {
          index: 0,
          width: res.content.width,
          height: res.content.height,
          imageData: res.content,
        },
      ]);
      setEntries([
        {
          // Clamped like every other inset source, same as `--from-9patch`.
          insets: clampInsets(res.insets, res.content.width, res.content.height, minMiddle),
          manual: { ...NO_MANUAL },
          fromGuess: false,
          confidence: 0,
        },
      ]);
      setNinePatchApplied(true);
      setNinePatchPadding(res.padding);
      setCustomSize(null);
      hasAutoFittedRef.current = false;
      toast.success(
        `Decoded .9.png — the 1px marker border was removed, leaving ${res.content.width}×${res.content.height}.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not decode the .9.png border");
    }
  };

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
  // Preview targets
  // -----------------------------------------------------------------
  const presetTargets = useMemo(() => {
    if (!currentFrame) return [];
    const { width: w, height: h } = currentFrame;
    return [
      { label: "1:1", w, h },
      { label: "Wide bar", w: w * 3, h },
      { label: "Tall column", w, h: h * 3 },
      { label: "Large panel", w: w * 3, h: Math.round(h * 2.5) },
    ];
  }, [currentFrame]);

  const custom =
    customSize ??
    (currentFrame ? { w: currentFrame.width * 4, h: currentFrame.height * 2 } : { w: 128, h: 64 });

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  const baseName = useMemo(() => {
    if (!sourceFile) return "sprite";
    return sourceFile.name.replace(/\.[^.]+$/, "").replace(/\.9$/, "");
  }, [sourceFile]);

  const jsonPayload = useMemo<NineSliceOutput | null>(() => {
    if (!sourceFile || frames.length === 0 || entries.length !== frames.length) return null;
    const f0 = frames[0];
    const cur = entries[Math.min(currentIndex, entries.length - 1)];
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      options: {
        auto: entries.some(isGuessed),
        explicit: explicitFrom(cur),
        alphaThreshold,
        tolerance,
        minMiddle,
        ...(ninePatchApplied ? { ninePatch: true } : {}),
      },
      nineSlice: frames.map((f, i) => {
        const entry = entries[i];
        const detected = isGuessed(entry);
        return {
          index: f.index,
          cell:
            f.cellRow != null && f.cellCol != null
              ? { row: f.cellRow, col: f.cellCol }
              : { row: Math.floor(f.index / sheetCols), col: f.index % sheetCols },
          insets: entry.insets,
          detected,
          confidence: detected ? entry.confidence : 0,
          regions: nineSliceRegions(entry.insets, f.width, f.height).map((r) => ({
            name: r.name,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            stretchX: r.stretchX,
            stretchY: r.stretchY,
          })),
        };
      }),
    };
  }, [
    sourceFile,
    frames,
    entries,
    currentIndex,
    sheetCols,
    sheetRows,
    sourceMode,
    alphaThreshold,
    tolerance,
    minMiddle,
    ninePatchApplied,
  ]);

  const downloadJson = () => {
    if (!jsonPayload) return;
    downloadBlob(
      new Blob([JSON.stringify(jsonPayload, null, 2)], { type: "application/json" }),
      `${baseName}-nine-slice.json`,
    );
    toast.success("Nine-slice JSON downloaded");
    setHasDownloaded(true);
  };

  const copyJson = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
      toast.success("Copied to clipboard");
      setHasDownloaded(true);
    } catch {
      toast.error("Copy failed");
    }
  };

  const downloadStretched = async () => {
    if (!currentFrame) return;
    const w = Math.max(1, custom.w, insets.left + insets.right);
    const h = Math.max(1, custom.h, insets.top + insets.bottom);
    try {
      const out = stretchNineSlice(currentFrame.imageData, insets, w, h);
      downloadBlob(await imageDataToBlob(out), `${baseName}-${w}x${h}.png`);
      toast.success(`Stretched PNG downloaded (${w}×${h})`);
      setHasDownloaded(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not render the stretched PNG");
    }
  };

  const downloadNinePatch = async () => {
    if (!currentFrame) return;
    try {
      const out = encodeNinePatch(currentFrame.imageData, insets, ninePatchPadding);
      downloadBlob(await imageDataToBlob(out), `${baseName}.9.png`);
      toast.success("Android .9.png downloaded");
      setHasDownloaded(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not encode the .9.png");
    }
  };

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        label: "Upload a panel",
        hint: "Drop a UI panel, button or frame — anything meant to be resized.",
        done: !!sourceUrl,
      },
      {
        label: "Place the guides",
        hint: "Drag the four guide lines so the corners stay fixed and the middle stretches. The stretched previews update as you drag — keep going until they look right.",
        done: entries.some((e) => SIDES.some((s) => e.manual[s])),
      },
      {
        label: "Export",
        hint: "Download the JSON, a stretched PNG, or an Android .9.png.",
        done: hasDownloaded,
      },
    ],
    [sourceUrl, entries, hasDownloaded],
  );
  const tutorial = useTutorial({ id: "nine-slice", steps: tutorialSteps });

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Nine-slice"
        description="Place four guides so a panel's corners stay fixed while its edges and middle stretch — export insets as JSON or an Android .9.png."
        icon={FrameIcon}
        category="metadata"
        docs="nine-slice"
      />
      <TutorialStrip
        open={tutorial.isOpen}
        steps={tutorialSteps}
        currentStep={tutorial.currentStep}
        onDismiss={tutorial.dismiss}
        onPrev={tutorial.goPrev}
        onNext={tutorial.goNext}
        onStepClick={tutorial.setCurrentStep}
      />
      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">Upload a panel or sheet.</CardDescription>
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

          {ninePatchOffer && (
            <Card className="border-primary/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">This looks like an Android .9.png</CardTitle>
                <CardDescription className="text-xs">
                  Its 1px border carries marker pixels. Decoding reads the insets from those markers
                  and strips the border, leaving a {frames[0] ? frames[0].width - 2 : 0}×
                  {frames[0] ? frames[0].height - 2 : 0} image. Nothing is removed until you say so.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button size="sm" className="w-full" onClick={applyNinePatch}>
                  <Scan className="w-3.5 h-3.5 mr-2" /> Decode the .9.png border
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Insets</CardTitle>
              <CardDescription className="text-xs">
                Drag the guides on the preview, or type exact pixel values here. Both stay in sync.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {SIDES.map((side) => {
                  const axisMax =
                    currentFrame && (side === "left" || side === "right")
                      ? currentFrame.width
                      : (currentFrame?.height ?? 0);
                  return (
                    <div key={side} className="space-y-1">
                      <Label className="text-xs capitalize">{side}</Label>
                      <Input
                        type="number"
                        min={0}
                        max={Math.max(0, axisMax - minMiddle)}
                        value={insets[side]}
                        disabled={!currentFrame}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setInset(side, n);
                        }}
                        className="h-8 text-sm font-mono"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Lock to all frames</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Every guide change applies to every frame.
                  </p>
                </div>
                <Switch checked={lockAll} onCheckedChange={setLockAll} />
              </div>

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={copyInsetsToAll}
                disabled={frames.length < 2}
              >
                <Copy className="w-3.5 h-3.5 mr-2" />
                Copy current insets to all
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Guess the insets</CardTitle>
              <CardDescription className="text-xs">
                A starting guess, not an answer. It reads how much each column and row differs from
                its neighbour and assumes the flattest run on each axis is the stretchable middle.
                That lands close on panels with an obviously flat or repeated middle, and badly on
                busy or gradient artwork — the guides above are the real interface.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => runGuess("current")}
                  disabled={frames.length === 0}
                >
                  <Wand2 className="w-3.5 h-3.5 mr-2" /> This frame
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => runGuess("all")}
                  disabled={frames.length < 2}
                >
                  <Wand2 className="w-3.5 h-3.5 mr-2" /> All frames
                </Button>
              </div>

              {currentEntry && (
                <p className="text-xs text-muted-foreground">
                  {isGuessed(currentEntry) ? (
                    <>
                      Current guides came from the guess, confidence{" "}
                      <span className="font-mono text-foreground">
                        {Math.round(currentEntry.confidence * 100)}%
                      </span>{" "}
                      — how much of each axis the flat run covered. Low means the artwork has no
                      flat middle to find; check the previews either way.
                    </>
                  ) : ninePatchApplied && !SIDES.some((s) => currentEntry.manual[s]) ? (
                    <>Current guides were decoded from the .9.png border.</>
                  ) : (
                    <>Current guides were set by hand.</>
                  )}
                </p>
              )}

              <div className="space-y-3 border-t border-dashed pt-4">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-xs">Alpha threshold</Label>
                    <span className="text-[10px] font-mono">{alphaThreshold}</span>
                  </div>
                  <Slider
                    value={[alphaThreshold]}
                    min={0}
                    max={64}
                    step={1}
                    onValueChange={(v) =>
                      updateGuessOptions({ alphaThreshold: Array.isArray(v) ? v[0] : v })
                    }
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Pixels under this alpha count as equal whatever their colour says.
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-xs">Tolerance</Label>
                    <span className="text-[10px] font-mono">{tolerance.toFixed(3)}</span>
                  </div>
                  <Slider
                    value={[tolerance]}
                    min={0}
                    max={0.2}
                    step={0.005}
                    onValueChange={(v) =>
                      updateGuessOptions({ tolerance: Array.isArray(v) ? v[0] : v })
                    }
                  />
                  <p className="text-[10px] text-muted-foreground">
                    How different two neighbouring lines may be and still count as the same.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Minimum middle (px)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={minMiddle}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (n >= 1) updateGuessOptions({ minMiddle: Math.floor(n) });
                    }}
                    className="h-8 text-sm font-mono"
                  />
                </div>
              </div>
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
                <Button
                  onClick={() => void downloadStretched()}
                  variant="outline"
                  className="w-full"
                >
                  <Download className="w-4 h-4 mr-2" /> Download stretched PNG
                </Button>
                <Button
                  onClick={() => void downloadNinePatch()}
                  variant="outline"
                  className="w-full"
                >
                  <Download className="w-4 h-4 mr-2" /> Download .9.png
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  The .9.png wraps this frame in the 1px marker border Android expects. One
                  contiguous stretch run per edge — the four insets above.
                </p>
                <JsonPreview data={jsonPayload} className="mt-2" />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8 space-y-6">
          <Card className="shadow-lg ring-1 ring-primary/10">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Guides</CardTitle>
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
                onZoomIn={() =>
                  currentFrame && viewport.setZoomIn(currentFrame.width, currentFrame.height)
                }
                onZoomOut={() =>
                  currentFrame && viewport.setZoomOut(currentFrame.width, currentFrame.height)
                }
                onReset={() =>
                  currentFrame && viewport.fitToView(currentFrame.width, currentFrame.height)
                }
              />
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                ref={previewContainerRef}
                className={cn(
                  "aspect-video min-h-96 rounded-lg border overflow-hidden relative touch-none",
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
                        className="block"
                        style={{
                          width: currentFrame.width,
                          height: currentFrame.height,
                          imageRendering: "pixelated",
                        }}
                      />
                      <GuideOverlay
                        width={currentFrame.width}
                        height={currentFrame.height}
                        insets={insets}
                        zoom={view.zoom}
                        onGuideDrag={setInset}
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
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      l{insets.left} r{insets.right} t{insets.top} b{insets.bottom}
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <FrameIcon className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload a panel to place its guides</p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-slate-900/20 border" /> corners — fixed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-sky-400/40 border" /> top/bottom edges —
                  stretch across
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-amber-400/40 border" /> left/right edges —
                  stretch down
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-emerald-400/40 border" /> middle —
                  stretches both ways
                </span>
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

          {currentFrame && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Stretched</CardTitle>
                <CardDescription className="text-xs">
                  The same frame rendered through the current guides at four target sizes. Corners
                  stay 1:1, edges repeat along one axis, the middle along both. Updates as you drag.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {presetTargets.map((t) => (
                    <StretchPreview
                      key={t.label}
                      image={currentFrame.imageData}
                      insets={insets}
                      targetWidth={t.w}
                      targetHeight={t.h}
                      label={t.label}
                      gridTheme={gridTheme}
                    />
                  ))}
                </div>

                <div className="space-y-3 border-t border-dashed pt-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Target width</Label>
                      <Input
                        type="number"
                        min={1}
                        value={custom.w}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (n > 0) setCustomSize({ w: Math.floor(n), h: custom.h });
                        }}
                        className="h-8 text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Target height</Label>
                      <Input
                        type="number"
                        min={1}
                        value={custom.h}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (n > 0) setCustomSize({ w: custom.w, h: Math.floor(n) });
                        }}
                        className="h-8 text-sm font-mono"
                      />
                    </div>
                  </div>
                  <StretchPreview
                    image={currentFrame.imageData}
                    insets={insets}
                    targetWidth={custom.w}
                    targetHeight={custom.h}
                    label="Custom size"
                    maxHeight={320}
                    gridTheme={gridTheme}
                  />
                </div>
              </CardContent>
            </Card>
          )}
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
