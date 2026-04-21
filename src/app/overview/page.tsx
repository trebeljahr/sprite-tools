"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Eye,
  Grid3x3,
  Layers,
  Loader2,
  Palette as PaletteIcon,
  Upload,
  Wand2,
} from "lucide-react";

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
import { generateOutline } from "@/lib/collision/outline";
import { useSharedProjectSource } from "@/lib/project/store";

interface CellData {
  index: number;
  row: number;
  col: number;
  width: number;
  height: number;
  imageData: ImageData;
  polygon: Array<{ x: number; y: number }>;
  pivot: { x: number; y: number };
}

type SourceMode = "single" | "sheet";

const PIVOT_PRESETS = [
  { id: "center", nx: 0.5, ny: 0.5, label: "Center" },
  { id: "top-center", nx: 0.5, ny: 0, label: "Top-center" },
  { id: "bottom-center", nx: 0.5, ny: 1, label: "Bottom-center (feet)" },
  { id: "top-left", nx: 0, ny: 0, label: "Top-left" },
  { id: "bottom-left", nx: 0, ny: 1, label: "Bottom-left" },
  { id: "top-right", nx: 1, ny: 0, label: "Top-right" },
  { id: "bottom-right", nx: 1, ny: 1, label: "Bottom-right" },
] as const;

async function frameToImageData(frame: Frame): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(frame.bitmap, 0, 0);
  return ctx.getImageData(0, 0, frame.width, frame.height);
}

export default function OverviewPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();
  const [sourceMode, setSourceMode] = useState<SourceMode>("single");
  const [sheetCols, setSheetCols] = useState(1);
  const [sheetRows, setSheetRows] = useState(1);
  const [detectedGrid, setDetectedGrid] = useState<{ cols: number; rows: number } | null>(null);

  const [cells, setCells] = useState<CellData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Overlay toggles
  const [showCollision, setShowCollision] = useState(true);
  const [showPivot, setShowPivot] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showIndex, setShowIndex] = useState(true);
  const [showTagBanner, setShowTagBanner] = useState(true);

  // Metadata parameters
  const [alphaThreshold, setAlphaThreshold] = useState(10);
  const [simplifyTolerance, setSimplifyTolerance] = useState(10);
  const [pivotPreset, setPivotPreset] = useState<typeof PIVOT_PRESETS[number]["id"]>("bottom-center");
  const [tagsJson, setTagsJson] = useState<string>("");

  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewport = useViewport();
  const { view, containerRef: previewContainerRef, baseView } = viewport;
  const hasAutoFittedRef = useRef(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Please upload an image.");
        return;
      }
      await setSharedSource(file);
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

  // Run detection on shared-source load
  useEffect(() => {
    if (!sourceFile) return;
    if (sheetCols > 1 || sheetRows > 1) return; // already detected
    detectSheetGrid(sourceFile)
      .then((det) => {
        if (det.confidence > 0 && (det.cols > 1 || det.rows > 1)) {
          setSourceMode("sheet");
          setSheetCols(det.cols);
          setSheetRows(det.rows);
          setDetectedGrid({ cols: det.cols, rows: det.rows });
        }
      })
      .catch(() => {});
  }, [sourceFile, sheetCols, sheetRows]);

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

  const effectiveCols = sourceMode === "single" ? 1 : Math.max(1, sheetCols);
  const effectiveRows = sourceMode === "single" ? 1 : Math.max(1, sheetRows);

  // Slice + compute overlays per cell whenever source / grid / overlay params change.
  useEffect(() => {
    if (!sourceFile) {
      setCells([]);
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
        const preset = PIVOT_PRESETS.find((p) => p.id === pivotPreset)!;
        const out: CellData[] = [];
        for (let i = 0; i < sliced.frames.length; i++) {
          const f = sliced.frames[i];
          const data = await frameToImageData(f);
          const outline = generateOutline(data, {
            alphaThreshold,
            simplifyTolerance,
            convexHull: false,
          });
          out.push({
            index: i,
            row: f.metadata?.cellRow ?? Math.floor(i / effectiveCols),
            col: f.metadata?.cellCol ?? i % effectiveCols,
            width: f.width,
            height: f.height,
            imageData: data,
            polygon: outline.polygon,
            pivot: {
              x: Math.round(preset.nx * (f.width - 1)),
              y: Math.round(preset.ny * (f.height - 1)),
            },
          });
        }
        if (!cancelled) {
          setCells(out);
          hasAutoFittedRef.current = false;
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          toast.error("Failed to compute overview");
        }
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceFile, effectiveCols, effectiveRows, alphaThreshold, simplifyTolerance, pivotPreset]);

  // Parse user-pasted tags JSON to colorize frames by tag ranges.
  const parsedTags = useMemo<
    Array<{ name: string; from: number; to: number; color: string }>
  >(() => {
    if (!showTagBanner || !tagsJson.trim()) return [];
    try {
      const parsed = JSON.parse(tagsJson);
      const tags = (parsed?.tags ?? parsed) as Array<{ name: string; from: number; to: number }>;
      if (!Array.isArray(tags)) return [];
      const palette = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#06b6d4", "#f97316"];
      return tags.map((t, i) => ({ ...t, color: palette[i % palette.length] }));
    } catch {
      return [];
    }
  }, [tagsJson, showTagBanner]);

  const tagForIndex = useCallback(
    (idx: number) =>
      parsedTags.find((t) => idx >= Math.min(t.from, t.to) && idx <= Math.max(t.from, t.to)),
    [parsedTags],
  );

  // Render everything to a single canvas — the sheet plus all overlays.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetW = cells[0]?.width ? cells[0].width * effectiveCols : 0;
  const sheetH = cells[0]?.height ? cells[0].height * effectiveRows : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cells.length === 0) return;
    canvas.width = sheetW;
    canvas.height = sheetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, sheetW, sheetH);

    // 1. Composite every cell image.
    for (const c of cells) {
      const tmp = document.createElement("canvas");
      tmp.width = c.width;
      tmp.height = c.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(c.imageData, 0, 0);
      ctx.drawImage(tmp, c.col * c.width, c.row * c.height);
    }

    // 2. Grid lines.
    if (showGrid && (effectiveCols > 1 || effectiveRows > 1)) {
      ctx.save();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const cellW = cells[0].width;
      const cellH = cells[0].height;
      for (let c = 1; c < effectiveCols; c++) {
        ctx.beginPath();
        ctx.moveTo(c * cellW + 0.5, 0);
        ctx.lineTo(c * cellW + 0.5, sheetH);
        ctx.stroke();
      }
      for (let r = 1; r < effectiveRows; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * cellH + 0.5);
        ctx.lineTo(sheetW, r * cellH + 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 3. Tag banners (per-cell colored border).
    if (showTagBanner && parsedTags.length > 0) {
      ctx.save();
      ctx.lineWidth = 2;
      for (const c of cells) {
        const tag = tagForIndex(c.index);
        if (!tag) continue;
        ctx.strokeStyle = tag.color;
        ctx.strokeRect(
          c.col * c.width + 1,
          c.row * c.height + 1,
          c.width - 2,
          c.height - 2,
        );
      }
      ctx.restore();
    }

    // 4. Collision polygons per cell.
    if (showCollision) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const c of cells) {
        if (c.polygon.length < 2) continue;
        const ox = c.col * c.width;
        const oy = c.row * c.height;
        ctx.beginPath();
        ctx.moveTo(ox + c.polygon[0].x + 0.5, oy + c.polygon[0].y + 0.5);
        for (let i = 1; i < c.polygon.length; i++) {
          ctx.lineTo(ox + c.polygon[i].x + 0.5, oy + c.polygon[i].y + 0.5);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(34, 197, 94, 0.18)";
        ctx.fill();
        ctx.strokeStyle = "rgba(22, 163, 74, 0.95)";
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. Pivot markers per cell.
    if (showPivot) {
      ctx.save();
      for (const c of cells) {
        const px = c.col * c.width + c.pivot.x + 0.5;
        const py = c.row * c.height + c.pivot.y + 0.5;
        ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(239, 68, 68, 1)";
        ctx.beginPath();
        ctx.arc(px, py, 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 6. Cell index labels.
    if (showIndex) {
      ctx.save();
      ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (const c of cells) {
        const label = `#${c.index}`;
        const w = ctx.measureText(label).width + 4;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(c.col * c.width + 1, c.row * c.height + 1, w, 12);
        ctx.fillStyle = "white";
        ctx.fillText(label, c.col * c.width + 3, c.row * c.height + 2);
      }
      ctx.restore();
    }
  }, [
    cells,
    sheetW,
    sheetH,
    showGrid,
    showCollision,
    showPivot,
    showIndex,
    showTagBanner,
    parsedTags,
    effectiveCols,
    effectiveRows,
    tagForIndex,
  ]);

  // Viewport autoload
  useEffect(() => {
    if (cells.length === 0 || hasAutoFittedRef.current) return;
    if (!previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(sheetW, sheetH);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [cells.length, sheetW, sheetH, previewContainerRef, viewport]);

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

  return (
    <main className="container mx-auto py-8 px-4">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center justify-center gap-2">
          <Layers className="w-8 h-8 text-primary" />
          Overview
        </h1>
        <p className="text-muted-foreground">
          Every frame&rsquo;s collision shape, pivot, and tag on one composited view.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Source</CardTitle>
              <CardDescription className="text-xs">
                Shared with Collision / Pivot / Tags / Pixelate / Normals / Palette / GIF pages.
              </CardDescription>
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

              {sourceFile && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Columns</Label>
                      <Input
                        type="number"
                        min={1}
                        value={sheetCols}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (n > 0) {
                            setSheetCols(n);
                            setSourceMode(n > 1 || sheetRows > 1 ? "sheet" : "single");
                          }
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
                          if (n > 0) {
                            setSheetRows(n);
                            setSourceMode(sheetCols > 1 || n > 1 ? "sheet" : "single");
                          }
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Overlays</CardTitle>
              <CardDescription className="text-xs">
                Toggle what to draw on top of every cell.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <OverlayToggle
                label="Collision polygon"
                on={showCollision}
                onChange={setShowCollision}
                hint="green outline per frame"
              />
              <OverlayToggle
                label="Pivot"
                on={showPivot}
                onChange={setShowPivot}
                hint="red dot per frame"
              />
              <OverlayToggle
                label="Cell grid"
                on={showGrid}
                onChange={setShowGrid}
                hint="dashed gutter lines"
              />
              <OverlayToggle
                label="Cell index"
                on={showIndex}
                onChange={setShowIndex}
                hint="#N in top-left"
              />
              <OverlayToggle
                label="Tag banner"
                on={showTagBanner}
                onChange={setShowTagBanner}
                hint="color each cell by its tag"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Parameters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Alpha threshold</Label>
                  <span className="text-[10px] font-mono">{alphaThreshold}</span>
                </div>
                <Slider
                  value={[alphaThreshold]}
                  min={0}
                  max={254}
                  step={1}
                  onValueChange={(v) =>
                    setAlphaThreshold(Array.isArray(v) ? v[0] : v)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Simplify tolerance</Label>
                  <span className="text-[10px] font-mono">
                    {simplifyTolerance.toFixed(1)}px
                  </span>
                </div>
                <Slider
                  value={[simplifyTolerance]}
                  min={0}
                  max={20}
                  step={0.1}
                  onValueChange={(v) =>
                    setSimplifyTolerance(Array.isArray(v) ? v[0] : v)
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Pivot preset</Label>
                <Select
                  value={pivotPreset}
                  onValueChange={(v) =>
                    v && setPivotPreset(v as typeof pivotPreset)
                  }
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PIVOT_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Tags JSON (optional)</CardTitle>
              <CardDescription className="text-xs">
                Paste output from the Tags page or `sprite-tools tags` to color cells by tag.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <textarea
                value={tagsJson}
                onChange={(e) => setTagsJson(e.target.value)}
                placeholder='{"tags":[{"name":"idle","from":0,"to":5},{"name":"run","from":6,"to":11}]}'
                className="w-full h-28 text-[10px] font-mono p-2 border rounded-md bg-muted/20"
              />
              {parsedTags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {parsedTags.map((t) => (
                    <div
                      key={t.name}
                      className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
                    >
                      <span className="w-2 h-2 rounded-sm" style={{ background: t.color }} />
                      <span className="font-mono">
                        {t.name} {t.from}–{t.to}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-8 space-y-6">
          <Card className="shadow-lg ring-1 ring-primary/10">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="w-4 h-4" />
                  Composited preview
                </CardTitle>
                {isProcessing && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              </div>
              <ViewportControls
                onZoomIn={() => sheetW && viewport.setZoomIn(sheetW, sheetH)}
                onZoomOut={() => sheetW && viewport.setZoomOut(sheetW, sheetH)}
                onReset={() => sheetW && viewport.fitToView(sheetW, sheetH)}
              />
            </CardHeader>
            <CardContent>
              <div
                ref={previewContainerRef}
                className="aspect-video min-h-96 rounded-lg border overflow-hidden relative cursor-move touch-none checkerboard-light"
              >
                {cells.length > 0 ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: sheetW,
                        height: sheetH,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <canvas
                        ref={canvasRef}
                        className="block"
                        style={{
                          width: sheetW,
                          height: sheetH,
                          imageRendering: "pixelated",
                        }}
                      />
                    </div>
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      {cells.length} cells · {effectiveCols}×{effectiveRows}
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Grid3x3 className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">
                      Upload a sheet here or in any other tool — it&apos;ll show up.
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <PaletteIcon className="w-3.5 h-3.5" />
            <span>
              Source is shared across tool tabs — upload once here and tune per-tool elsewhere.
            </span>
          </div>
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

function OverlayToggle({
  label,
  on,
  onChange,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between p-2 rounded-lg border bg-muted/5 cursor-pointer">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && (
          <div className="text-[10px] text-muted-foreground leading-tight">{hint}</div>
        )}
      </div>
      <Switch checked={on} onCheckedChange={onChange} />
    </label>
  );
}
