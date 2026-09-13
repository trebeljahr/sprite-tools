"use client";

import type * as React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import JSZip from "jszip";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Droplet,
  FileJson,
  Grid3x3,
  ImageIcon,
  Layers,
  Loader2,
  Package,
  Palette as PaletteIcon,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { detectSheetGrid, importFromSpriteSheet } from "@/lib/pipeline/import";
import type { Frame } from "@/lib/pipeline/types";
import {
  applyPaletteSwap,
  extractPalette,
  hexToRgb,
  rgbToHex,
  type SwapEntry,
} from "@/lib/palette/extract";
import { rotateHue } from "@/lib/palette/oklab";
import {
  DEFAULT_HUE_TOLERANCE,
  detectRamps,
  type Ramp,
  rampBaseColor,
  remapRamp,
} from "@/lib/palette/ramps";
import {
  describeRamps,
  hueShiftVariants,
  resolveVariant,
  slugifyVariantName,
  VARIANT_MANIFEST_VERSION,
  type VariantManifest,
  type VariantSpec,
  variantFileName,
} from "@/lib/palette/variants";
import type { RGB } from "@/lib/pixel-art/pixelate";
import { track } from "@/lib/analytics";
import { VariantGrid, type VariantPreview } from "@/components/variant-grid";
import { useSharedProjectSource } from "@/lib/project/store";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";

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

function sameRgb(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** Stitch every frame back into the source grid with `swaps` applied. */
async function renderSheetBlob(
  frames: SourceFrame[],
  palette: RGB[],
  swaps: SwapEntry[],
  cols: number,
  rows: number,
): Promise<Blob | null> {
  if (frames.length === 0) return null;
  const cellW = frames[0].width;
  const cellH = frames[0].height;
  const canvas = document.createElement("canvas");
  canvas.width = cellW * cols;
  canvas.height = cellH * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const tmp = document.createElement("canvas");
  tmp.width = cellW;
  tmp.height = cellH;
  const tctx = tmp.getContext("2d");
  if (!tctx) return null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const c = f.cellCol ?? i % cols;
    const r = f.cellRow ?? Math.floor(i / cols);
    const out = swaps.length > 0 ? applyPaletteSwap(f.imageData, palette, swaps) : f.imageData;
    tctx.clearRect(0, 0, cellW, cellH);
    tctx.putImageData(out, 0, 0);
    ctx.drawImage(tmp, c * cellW, r * cellH);
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

export default function PalettePage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [frames, setFrames] = useState<SourceFrame[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDownloaded, setHasDownloaded] = useState(false);

  const [colorCount, setColorCount] = useState(8);
  const [palette, setPalette] = useState<RGB[]>([]);
  // swapHex[i] = hex string the user wants palette[i] to become.
  const [swapHex, setSwapHex] = useState<string[]>([]);

  const [rampTolerance, setRampTolerance] = useState(DEFAULT_HUE_TOLERANCE);
  const [variants, setVariants] = useState<VariantSpec[]>([]);
  // "hue" once a hue set generated the list — recorded in the manifest so a
  // consumer knows whether the variants came from rotations or hand-picked defs.
  const [variantMode, setVariantMode] = useState<"defs" | "hue">("defs");
  const [hueSetCount, setHueSetCount] = useState(6);
  const [isExporting, setIsExporting] = useState(false);

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

  // Slice
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
  // Extract palette: union of pixels across ALL frames so a shared palette
  // applies consistently to every frame of a sheet.
  // -----------------------------------------------------------------
  useEffect(() => {
    if (frames.length === 0) {
      setPalette([]);
      setSwapHex([]);
      return;
    }
    // Concat all frames' ImageData into one big ImageData for extraction.
    let total = 0;
    for (const f of frames) total += f.width * f.height;
    const merged = new ImageData(total, 1);
    let off = 0;
    for (const f of frames) {
      const n = f.width * f.height * 4;
      merged.data.set(f.imageData.data, off);
      off += n;
    }
    const pal = extractPalette(merged, colorCount);
    setPalette(pal);
    setSwapHex(pal.map(rgbToHex));
  }, [frames, colorCount]);

  // Ramps: the palette grouped into shading runs. Recomputed whenever the
  // palette or the hue tolerance changes; cheap (palette-sized, not pixel-sized).
  const ramps = useMemo<Ramp[]>(
    () => detectRamps(palette, { hueTolerance: rampTolerance }),
    [palette, rampTolerance],
  );

  const currentSwaps = useMemo<SwapEntry[]>(
    () =>
      palette
        .map((p, i) => ({ from: p, to: hexToRgb(swapHex[i] ?? rgbToHex(p)) }))
        .filter((s) => !sameRgb(s.from, s.to)),
    [palette, swapHex],
  );

  // Derived: recolored frame (applies to current frame for preview).
  const swappedCurrent = useMemo<ImageData | null>(() => {
    const f = frames[currentIndex];
    if (!f || palette.length === 0 || currentSwaps.length === 0) return null;
    return applyPaletteSwap(f.imageData, palette, currentSwaps);
  }, [frames, currentIndex, palette, currentSwaps]);

  // Canvas render
  const current = frames[currentIndex];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(swappedCurrent ?? current.imageData, 0, 0);
  }, [current, swappedCurrent]);

  // Viewport
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
  // Swap handlers
  // -----------------------------------------------------------------
  const setSwap = (i: number, hex: string) => {
    setSwapHex((prev) => {
      const next = [...prev];
      next[i] = hex;
      return next;
    });
  };

  const resetSwaps = () => {
    setSwapHex(palette.map(rgbToHex));
  };

  // Perceptual (OKLCH) rotation, the same maths the CLI and MCP run — an HSL
  // rotation would darken the blues and mud up the saturated shades.
  const shiftHue = (delta: number) => {
    setSwapHex((prev) => prev.map((hex) => rgbToHex(rotateHue(hexToRgb(hex), delta))));
  };

  // -----------------------------------------------------------------
  // Ramp remap — the headline: one new base color re-tints a whole ramp.
  // -----------------------------------------------------------------
  const applyRampBase = (ramp: Ramp, hex: string) => {
    const swaps = remapRamp(ramp, hexToRgb(hex));
    setSwapHex((prev) => {
      const next = [...prev];
      const setFor = (from: RGB, to: string) => {
        for (let i = 0; i < palette.length; i++) if (sameRgb(palette[i], from)) next[i] = to;
      };
      // remapRamp always works off the ramp's *original* colors, so clear the
      // previous re-tint first — otherwise dragging the picker would leave the
      // shades it no longer touches stuck on the last tint.
      for (const c of ramp.colors) setFor(c, rgbToHex(c));
      for (const s of swaps) setFor(s.from, rgbToHex(s.to));
      return next;
    });
  };

  const resetRamp = (ramp: Ramp) => applyRampBase(ramp, rgbToHex(rampBaseColor(ramp)));

  /** Where a ramp currently points: the swap target of its anchor shade. */
  const rampTargetHex = (ramp: Ramp): string => {
    const anchor = rampBaseColor(ramp);
    const i = palette.findIndex((p) => sameRgb(p, anchor));
    return (i >= 0 ? swapHex[i] : undefined) ?? rgbToHex(anchor);
  };

  // -----------------------------------------------------------------
  // Variants
  // -----------------------------------------------------------------
  const generateHueSet = () => {
    const count = Math.min(12, Math.max(2, Math.round(hueSetCount)));
    setVariants(hueShiftVariants(count));
    setVariantMode("hue");
  };

  const addVariantFromCurrent = () => {
    // Seed from whatever the user has already swapped, so the palette /ramp
    // editing above doubles as the editor for a new variant.
    const swaps: Record<string, string> = {};
    for (const s of currentSwaps) swaps[rgbToHex(s.from)] = rgbToHex(s.to);
    setVariants((prev) => {
      const used = new Set(prev.map((v) => slugifyVariantName(v.name)));
      let n = prev.length + 1;
      while (used.has(`variant-${n}`)) n++;
      const spec: VariantSpec = { name: `Variant ${n}` };
      if (Object.keys(swaps).length > 0) spec.swaps = swaps;
      else spec.hueShift = 0;
      return [...prev, spec];
    });
    setVariantMode("defs");
  };

  const updateVariant = (index: number, patch: Partial<VariantSpec>) => {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
    setVariantMode("defs");
  };

  const setVariantRampTarget = (index: number, baseHex: string, toHex: string) => {
    setVariants((prev) =>
      prev.map((v, i) => {
        if (i !== index) return v;
        const rest = (v.ramps ?? []).filter((r) => r.base !== baseHex);
        const ramps = toHex === baseHex ? rest : [...rest, { base: baseHex, to: toHex }];
        return ramps.length > 0 ? { ...v, ramps } : { ...v, ramps: undefined };
      }),
    );
    setVariantMode("defs");
  };

  /** Pull the palette card's current single-color swaps into one variant. */
  const captureSwapsInto = (index: number) => {
    const swaps: Record<string, string> = {};
    for (const s of currentSwaps) swaps[rgbToHex(s.from)] = rgbToHex(s.to);
    updateVariant(index, { swaps: Object.keys(swaps).length > 0 ? swaps : undefined });
    toast.success(`Captured ${currentSwaps.length} swaps`);
  };

  const removeVariant = (index: number) => {
    setVariants((prev) => prev.filter((_, i) => i !== index));
  };

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------
  const baseName = useMemo(
    () => (sourceFile ? sourceFile.name.replace(/\.[^.]+$/, "") : "sprite"),
    [sourceFile],
  );

  // Variant previews are the expensive branch (one full recolor per variant),
  // so resolve them off a deferred copy of the list: dragging a variant's color
  // input keeps repainting the input while the grid catches up a beat later.
  const deferredVariants = useDeferredValue(variants);
  const variantPreviews = useMemo<VariantPreview[]>(() => {
    if (palette.length === 0) return [];
    return deferredVariants.map((spec) => ({
      name: spec.name,
      slug: slugifyVariantName(spec.name),
      file: variantFileName(baseName, spec.name),
      swaps: resolveVariant(spec, palette, ramps),
    }));
  }, [deferredVariants, palette, ramps, baseName]);

  // Two variants that slugify the same would write the same PNG name, and the
  // CLI's parseVariantSet rejects that outright — so catch it here too instead
  // of silently dropping a file from the ZIP.
  const duplicateName = useMemo<string | null>(() => {
    const seen = new Set<string>();
    for (const v of variantPreviews) {
      if (seen.has(v.slug)) return v.name;
      seen.add(v.slug);
    }
    return null;
  }, [variantPreviews]);

  const manifest = useMemo<VariantManifest | null>(() => {
    if (!sourceFile || frames.length === 0 || palette.length === 0) return null;
    if (variantPreviews.length === 0) return null;
    const f0 = frames[0];
    return {
      version: VARIANT_MANIFEST_VERSION,
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      options: { colors: colorCount, mode: variantMode, rampTolerance },
      palette: palette.map(rgbToHex),
      ramps: describeRamps(ramps),
      variants: variantPreviews.map((v, i) => {
        const hueShift = deferredVariants[i]?.hueShift;
        return {
          name: v.name,
          slug: v.slug,
          file: v.file,
          ...(hueShift === undefined ? {} : { hueShift }),
          swaps: v.swaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) })),
        };
      }),
    };
  }, [
    sourceFile,
    frames,
    palette,
    ramps,
    variantPreviews,
    deferredVariants,
    sheetCols,
    sheetRows,
    sourceMode,
    colorCount,
    variantMode,
    rampTolerance,
  ]);

  // Same shape as `sprite-tools palette` CLI output. Built via useMemo so the
  // JSON preview panel can render it live without duplicating assembly.
  const jsonPayload = useMemo(() => {
    if (!sourceFile || palette.length === 0 || frames.length === 0) return null;
    const f0 = frames[0];
    const swaps = currentSwaps.map((s) => ({ from: rgbToHex(s.from), to: rgbToHex(s.to) }));
    return {
      source: sourceFile.name,
      frameWidth: f0.width,
      frameHeight: f0.height,
      grid: { cols: sheetCols, rows: sheetRows, detected: sourceMode === "sheet" },
      options: { colors: colorCount, rampTolerance },
      palette: palette.map(rgbToHex),
      ramps: describeRamps(ramps),
      swaps,
      ...(manifest ? { variants: manifest.variants } : {}),
    };
  }, [
    sourceFile,
    palette,
    currentSwaps,
    frames,
    ramps,
    manifest,
    sheetCols,
    sheetRows,
    sourceMode,
    colorCount,
    rampTolerance,
  ]);

  const exportPaletteJson = () => {
    if (!jsonPayload || !sourceFile) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download = `${base}-palette.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Palette JSON downloaded");
    setHasDownloaded(true);
  };

  const downloadCurrent = async () => {
    const f = frames[currentIndex];
    if (!f || !sourceFile) return;
    const out = swappedCurrent ?? f.imageData;
    const blob = await imageDataToBlob(out);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const base = sourceFile.name.replace(/\.[^.]+$/, "");
    a.download =
      sourceMode === "sheet" ? `${base}-recolor-${currentIndex}.png` : `${base}-recolor.png`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Recolored frame downloaded");
    setHasDownloaded(true);
  };

  const exportCols = sourceMode === "sheet" ? effectiveCols : 1;
  // Size from the grid, not the surviving frame count: importing a sheet drops
  // empty cells, so frames.length can be short of cols*rows. Deriving rows
  // from it would place the last frames past the bottom edge and lose them.
  const exportRows = sourceMode === "sheet" ? effectiveRows : Math.ceil(frames.length / exportCols);

  const downloadStitched = async () => {
    if (frames.length === 0 || !sourceFile || palette.length === 0) return;
    const blob = await renderSheetBlob(frames, palette, currentSwaps, exportCols, exportRows);
    if (!blob) return;
    downloadBlob(blob, `${baseName}-recolor-sheet.png`);
    toast.success("Recolored sheet downloaded");
    setHasDownloaded(true);
  };

  const downloadManifest = () => {
    if (!manifest) return;
    downloadBlob(
      new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
      `${baseName}-variants.json`,
    );
    toast.success("Variant manifest downloaded");
    setHasDownloaded(true);
  };

  const downloadVariantsZip = async () => {
    if (!manifest || frames.length === 0 || variantPreviews.length === 0) return;
    if (duplicateName) {
      toast.error(`Two variants share the filename for "${duplicateName}" — rename one first`);
      return;
    }
    setIsExporting(true);
    try {
      const zip = new JSZip();
      for (const variant of variantPreviews) {
        // Sheets go back out stitched to the source grid, matching what the CLI
        // writes for the same variant set.
        const blob = await renderSheetBlob(frames, palette, variant.swaps, exportCols, exportRows);
        if (blob) zip.file(variant.file, blob);
      }
      zip.file(`${baseName}-variants.json`, JSON.stringify(manifest, null, 2));
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName}-variants.zip`);
      track("export", {
        tool: "palette",
        format: "variants-zip",
        variants: variantPreviews.length,
      });
      toast.success(`Exported ${variantPreviews.length} variants as ZIP`);
      setHasDownloaded(true);
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const copyPalette = async () => {
    if (palette.length === 0) return;
    try {
      await navigator.clipboard.writeText(palette.map(rgbToHex).join("\n"));
      toast.success("Palette copied");
      setHasDownloaded(true);
    } catch {
      toast.error("Copy failed");
    }
  };

  const tutorialSteps: TutorialStep[] = useMemo(
    () => [
      {
        label: "Upload a sprite",
        hint: "Drop an image or click a sample.",
        done: !!sourceUrl,
      },
      {
        label: "Extract palette",
        hint: "Pick how many colors to extract; the dominant palette appears below.",
        done: palette.length > 0,
      },
      {
        label: "Re-tint a ramp",
        hint: "Pick one new base color and the whole shading ramp follows, steps intact.",
        done: currentSwaps.length > 0,
      },
      {
        label: "Build variants",
        hint: "Generate a hue set or add your own — every variant previews side by side.",
        done: variants.length > 0,
      },
      {
        label: "Export",
        hint: "Save a recolored PNG, the variant ZIP, or the JSON manifest.",
        done: hasDownloaded,
      },
    ],
    [sourceUrl, palette.length, currentSwaps.length, variants.length, hasDownloaded],
  );
  const tutorial = useTutorial({ id: "palette", steps: tutorialSteps });

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Palette"
        description="Extract the dominant colors — then swap any of them to recolor the whole sprite."
        icon={PaletteIcon}
        category="transform"
        docs="palette"
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

          {ramps.length > 0 && (
            <Card className="ring-1 ring-primary/20">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-primary" /> Ramps
                </CardTitle>
                <CardDescription className="text-xs">
                  Pick <strong className="text-foreground">one</strong> new base color — the whole
                  shading ramp re-tints, keeping its lightness steps and its shadow/highlight hue
                  drift.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {ramps.map((ramp) => (
                  <RampRow
                    key={`ramp-${ramp.index}`}
                    ramp={ramp}
                    targetHex={rampTargetHex(ramp)}
                    shadeHexes={ramp.colors.map((c) => {
                      const i = palette.findIndex((p) => sameRgb(p, c));
                      return (i >= 0 ? swapHex[i] : undefined) ?? rgbToHex(c);
                    })}
                    onBase={(hex) => applyRampBase(ramp, hex)}
                    onReset={() => resetRamp(ramp)}
                  />
                ))}
                <div className="space-y-1.5 pt-1 border-t border-dashed">
                  <div className="flex justify-between">
                    <Label className="text-xs">Hue tolerance</Label>
                    <span className="text-[10px] font-mono">{rampTolerance}°</span>
                  </div>
                  <Slider
                    value={[rampTolerance]}
                    min={5}
                    max={90}
                    step={1}
                    onValueChange={(v) => setRampTolerance(Array.isArray(v) ? v[0] : v)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    How far apart two hues can be and still count as one ramp. Greys always land in
                    their own bucket.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Palette</CardTitle>
              <CardDescription className="text-xs">
                Click a swatch to pick a replacement color.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Colors</Label>
                  <span className="text-[10px] font-mono">{colorCount}</span>
                </div>
                <Slider
                  value={[colorCount]}
                  min={2}
                  max={32}
                  step={1}
                  onValueChange={(v) => setColorCount(Array.isArray(v) ? v[0] : v)}
                />
              </div>

              {palette.length > 0 && (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    {palette.map((c, i) => (
                      <PaletteSwatch
                        // biome-ignore lint/suspicious/noArrayIndexKey: palette order is stable; index disambiguates duplicate hex values
                        key={`${rgbToHex(c)}-${i}`}
                        sourceHex={rgbToHex(c)}
                        currentHex={swapHex[i] ?? rgbToHex(c)}
                        onChange={(hex) => setSwap(i, hex)}
                      />
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1 pt-2 border-t border-dashed">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(-30)}
                      className="h-8 text-[10px]"
                    >
                      Hue −30°
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(180)}
                      className="h-8 text-[10px]"
                    >
                      Invert hue
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => shiftHue(30)}
                      className="h-8 text-[10px]"
                    >
                      Hue +30°
                    </Button>
                  </div>
                  <Button size="sm" variant="outline" className="w-full" onClick={resetSwaps}>
                    <RotateCcw className="w-3.5 h-3.5 mr-2" /> Reset swaps
                  </Button>
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
                  <Download className="w-4 h-4 mr-2" /> Recolored frame (PNG)
                </Button>
                {frames.length > 1 && (
                  <Button onClick={downloadStitched} variant="outline" className="w-full">
                    <Grid3x3 className="w-4 h-4 mr-2" /> Recolored sheet (PNG)
                  </Button>
                )}
                {variantPreviews.length > 0 && (
                  <>
                    <Button
                      onClick={() => void downloadVariantsZip()}
                      disabled={isExporting}
                      variant="outline"
                      className="w-full"
                    >
                      {isExporting ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Package className="w-4 h-4 mr-2" />
                      )}
                      {variantPreviews.length} variants + manifest (ZIP)
                    </Button>
                    <Button onClick={downloadManifest} variant="outline" className="w-full">
                      <FileJson className="w-4 h-4 mr-2" /> Variant manifest (JSON)
                    </Button>
                  </>
                )}
                <Button onClick={exportPaletteJson} variant="outline" className="w-full">
                  <Droplet className="w-4 h-4 mr-2" /> Palette JSON
                </Button>
                <Button onClick={copyPalette} variant="ghost" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy hex list
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
                {isProcessing && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setGridTheme((p) => (p === "light" ? "dark" : "light"))}
                >
                  <PaletteIcon
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
                    <PaletteIcon className="w-10 h-10 opacity-30 mb-2" />
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

          {palette.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-4 h-4" /> Variants
                </CardTitle>
                <CardDescription className="text-xs">
                  One sprite, many recolors. Every variant previews below, rendered from the frame
                  you are looking at.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1 w-20">
                    <Label className="text-xs">Hue set</Label>
                    <Input
                      type="number"
                      min={2}
                      max={12}
                      value={hueSetCount}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (n >= 2 && n <= 12) setHueSetCount(n);
                      }}
                      className="h-8 text-sm"
                    />
                  </div>
                  <Button size="sm" variant="outline" onClick={generateHueSet} className="h-8">
                    <Wand2 className="w-3.5 h-3.5 mr-1.5" /> Generate rotations
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addVariantFromCurrent}
                    className="h-8"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1.5" /> Add current recolor
                  </Button>
                  {variants.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVariants([])}
                      className="h-8"
                    >
                      Clear
                    </Button>
                  )}
                </div>

                {variants.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Generate an evenly spaced hue set for enemy tints, or recolor with the ramp
                    controls and add that as a named variant.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {variants.map((spec, i) => (
                      <VariantRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: list position is the identity here; names are user-editable and may collide mid-typing
                        key={`variant-${i}`}
                        spec={spec}
                        ramps={ramps}
                        fileName={variantFileName(baseName, spec.name)}
                        onName={(name) => updateVariant(i, { name })}
                        onHueShift={(hueShift) => updateVariant(i, { hueShift })}
                        onRampTarget={(base, to) => setVariantRampTarget(i, base, to)}
                        onCaptureSwaps={() => captureSwapsInto(i)}
                        onRemove={() => removeVariant(i)}
                      />
                    ))}
                  </div>
                )}

                {duplicateName && (
                  <p className="text-xs text-destructive">
                    “{duplicateName}” collides with another variant’s filename — rename it before
                    exporting.
                  </p>
                )}

                <VariantGrid
                  frame={current?.imageData ?? null}
                  palette={palette}
                  variants={variantPreviews}
                />
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

// -----------------------------------------------------------------
// Swatch w/ color picker
// -----------------------------------------------------------------
function PaletteSwatch({
  sourceHex,
  currentHex,
  onChange,
}: {
  sourceHex: string;
  currentHex: string;
  onChange: (hex: string) => void;
}) {
  const changed = sourceHex.toLowerCase() !== currentHex.toLowerCase();
  return (
    <label
      className={cn(
        "flex items-center gap-2 p-1.5 rounded border transition-colors cursor-pointer hover:bg-muted/30",
        changed && "border-primary/60",
      )}
      title={`${sourceHex} → ${currentHex}`}
    >
      <div className="relative w-8 h-8 rounded-sm shrink-0 overflow-hidden border border-border/40">
        <div className="absolute inset-0" style={{ background: sourceHex }} />
        <div
          className="absolute bottom-0 right-0 w-4 h-4 border-l border-t border-white/60"
          style={{ background: currentHex }}
        />
      </div>
      <input
        type="color"
        value={currentHex}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
      <span className="text-[10px] font-mono truncate">
        {changed ? `${currentHex}` : sourceHex}
      </span>
    </label>
  );
}

// -----------------------------------------------------------------
// Ramp row — the whole-ramp re-tint control
// -----------------------------------------------------------------
function RampRow({
  ramp,
  targetHex,
  shadeHexes,
  onBase,
  onReset,
}: {
  ramp: Ramp;
  /** Where the ramp currently points (its anchor's swap target). */
  targetHex: string;
  /** Current target color of every shade, in ascending-lightness order. */
  shadeHexes: string[];
  onBase: (hex: string) => void;
  onReset: () => void;
}) {
  const sourceBase = rgbToHex(rampBaseColor(ramp));
  const changed = targetHex.toLowerCase() !== sourceBase.toLowerCase();
  const label = ramp.achromatic ? "Greys" : `Ramp ${ramp.index + 1}`;

  return (
    <div className={cn("rounded-lg border p-2 space-y-2", changed && "border-primary/60")}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label} · {ramp.colors.length} {ramp.colors.length === 1 ? "shade" : "shades"}
        </span>
        {changed && (
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 rounded overflow-hidden border border-border/60">
          {ramp.colors.map((c, i) => {
            const from = rgbToHex(c);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: shades are sorted by lightness and may repeat a hex; the position is the identity
                key={`${from}-${i}`}
                className="h-8 flex-1 relative"
                style={{ background: shadeHexes[i] ?? from }}
                title={`${from} → ${shadeHexes[i] ?? from}`}
              >
                {i === ramp.anchorIndex && (
                  <span className="absolute inset-x-0 bottom-0.5 mx-auto w-1.5 h-1.5 rounded-full bg-white/90 ring-1 ring-black/40" />
                )}
              </div>
            );
          })}
        </div>
        <label
          className="flex items-center gap-1.5 px-2 h-8 rounded border cursor-pointer hover:bg-muted/40 shrink-0"
          title={`Re-tint the whole ramp — base ${sourceBase} → ${targetHex}`}
        >
          <span
            className="w-4 h-4 rounded-sm border border-border/60"
            style={{ background: targetHex }}
          />
          <span className="text-[10px] font-medium">Re-tint</span>
          <input
            type="color"
            value={targetHex}
            onChange={(e) => onBase(e.target.value)}
            className="sr-only"
          />
        </label>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------
// Variant row — name, hue rotation and one base color per ramp
// -----------------------------------------------------------------
function VariantRow({
  spec,
  ramps,
  fileName,
  onName,
  onHueShift,
  onRampTarget,
  onCaptureSwaps,
  onRemove,
}: {
  spec: VariantSpec;
  ramps: Ramp[];
  fileName: string;
  onName: (name: string) => void;
  onHueShift: (deg: number) => void;
  onRampTarget: (baseHex: string, toHex: string) => void;
  onCaptureSwaps: () => void;
  onRemove: () => void;
}) {
  const swapCount = Object.keys(spec.swaps ?? {}).length;
  return (
    <div className="rounded-lg border p-2 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={spec.name}
          onChange={(e) => onName(e.target.value)}
          className="h-8 text-sm flex-1 min-w-0"
        />
        <div className="flex items-center gap-1 shrink-0">
          <Label className="text-[10px] text-muted-foreground">Hue</Label>
          <Input
            type="number"
            step={5}
            value={spec.hueShift ?? 0}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onHueShift(n);
            }}
            className="h-8 w-16 text-sm"
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onCaptureSwaps}
          className="h-8 w-8 shrink-0"
          title="Replace this variant's individual swaps with the palette edits above"
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
        <Button size="icon" variant="ghost" onClick={onRemove} className="h-8 w-8 shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground">Ramp bases</span>
        {ramps.map((ramp) => {
          const base = rgbToHex(rampBaseColor(ramp));
          const to = spec.ramps?.find((r) => r.base === base)?.to ?? base;
          return (
            <label
              key={`vr-${ramp.index}`}
              className="w-5 h-5 rounded-sm border border-border/60 cursor-pointer"
              style={{ background: to }}
              title={`${ramp.achromatic ? "Greys" : `Ramp ${ramp.index + 1}`}: ${base} → ${to}`}
            >
              <input
                type="color"
                value={to}
                onChange={(e) => onRampTarget(base, e.target.value)}
                className="sr-only"
              />
            </label>
          );
        })}
        <span className="text-[10px] font-mono text-muted-foreground ml-auto truncate">
          {fileName}
          {swapCount > 0 && ` · ${swapCount} swaps`}
        </span>
      </div>
    </div>
  );
}
