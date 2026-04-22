"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Boxes,
  Copy,
  Download,
  Loader2,
  Palette,
  Trash2,
  Upload,
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
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ToolHeader } from "@/components/tool-header";
import { useViewport } from "@/hooks/use-viewport";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import {
  computeTrimRect,
  packAtlas,
  type PackInput,
  type PackedAtlas,
} from "@/lib/atlas/pack";

interface AtlasSprite {
  id: string;
  name: string;
  fullWidth: number;
  fullHeight: number;
  trim: { x: number; y: number; w: number; h: number } | null;
  /** Post-trim ImageData (tight to opaque content). */
  content: ImageData;
}

function newSpriteId(): string {
  return `s${Math.random().toString(36).slice(2, 9)}`;
}

async function fileToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();
  return data;
}

function trimImageData(src: ImageData, rect: { x: number; y: number; w: number; h: number }): ImageData {
  const out = new ImageData(rect.w, rect.h);
  const sd = src.data;
  const od = out.data;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const si = ((y + rect.y) * src.width + (x + rect.x)) * 4;
      const oi = (y * rect.w + x) * 4;
      od[oi] = sd[si];
      od[oi + 1] = sd[si + 1];
      od[oi + 2] = sd[si + 2];
      od[oi + 3] = sd[si + 3];
    }
  }
  return out;
}

export default function AtlasPage() {
  const [sprites, setSprites] = useState<AtlasSprite[]>([]);
  const [padding, setPadding] = useState(2);
  const [pow2, setPow2] = useState(false);
  const [autoTrim, setAutoTrim] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const viewport = useViewport();
  const { view, containerRef: previewContainerRef, baseView } = viewport;
  const hasAutoFittedRef = useRef(false);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setIsLoading(true);
    try {
      const incoming: AtlasSprite[] = [];
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        const data = await fileToImageData(file);
        const trim = autoTrim ? computeTrimRect(data) : null;
        const content = trim ? trimImageData(data, trim) : data;
        incoming.push({
          id: newSpriteId(),
          name: file.name,
          fullWidth: data.width,
          fullHeight: data.height,
          trim,
          content,
        });
      }
      setSprites((prev) => [...prev, ...incoming]);
      if (incoming.length > 0) hasAutoFittedRef.current = false;
    } catch (e) {
      toast.error(`Load failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    void handleFiles(files);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    void handleFiles(files);
  };

  const clearAll = () => setSprites([]);
  const removeSprite = (id: string) => setSprites((prev) => prev.filter((s) => s.id !== id));

  // -----------------------------------------------------------------
  // Re-trim when autoTrim toggles — the content ImageData depends on it.
  // Reload via a simple re-pack of the same sprites: we already have the
  // content, so toggling autoTrim should recompute from the full frame.
  // For simplicity, we just reload from the files when toggled — but we
  // no longer have the source File. So instead we warn the user.
  // -----------------------------------------------------------------
  // (Skipped — user can clear + reupload to switch trim modes cleanly.)

  // -----------------------------------------------------------------
  // Pack
  // -----------------------------------------------------------------
  const atlas = useMemo<PackedAtlas | null>(() => {
    if (sprites.length === 0) return null;
    try {
      const inputs: PackInput[] = sprites.map((s) => ({
        id: s.id,
        width: s.content.width,
        height: s.content.height,
      }));
      const trim = new Map<string, { sourceWidth: number; sourceHeight: number; offsetX: number; offsetY: number } | undefined>();
      for (const s of sprites) {
        if (s.trim) {
          trim.set(s.id, {
            sourceWidth: s.fullWidth,
            sourceHeight: s.fullHeight,
            offsetX: s.trim.x,
            offsetY: s.trim.y,
          });
        }
      }
      return packAtlas(inputs, trim, { padding, powerOfTwo: pow2 });
    } catch (e) {
      toast.error(`Pack failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [sprites, padding, pow2]);

  // -----------------------------------------------------------------
  // Render atlas to an offscreen canvas and display via img URL
  // -----------------------------------------------------------------
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !atlas) return;
    canvas.width = atlas.width || 1;
    canvas.height = atlas.height || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const f of atlas.frames) {
      const s = sprites.find((x) => x.id === f.id);
      if (!s) continue;
      const tmp = document.createElement("canvas");
      tmp.width = s.content.width;
      tmp.height = s.content.height;
      const tctx = tmp.getContext("2d");
      if (!tctx) continue;
      tctx.putImageData(s.content, 0, 0);
      ctx.drawImage(tmp, f.x, f.y);
    }

    // Optional frame outlines
    ctx.strokeStyle = "rgba(74, 222, 128, 0.5)";
    ctx.lineWidth = 1;
    for (const f of atlas.frames) {
      ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.width - 1, f.height - 1);
    }
  }, [atlas, sprites]);

  // Auto-fit viewport
  useEffect(() => {
    if (!atlas || hasAutoFittedRef.current || !previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(atlas.width, atlas.height);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [atlas, previewContainerRef, viewport]);

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
  const jsonPayload = useMemo(() => {
    if (!atlas) return null;
    const byId = new Map(sprites.map((s) => [s.id, s]));
    return {
      atlas: "atlas.png",
      width: atlas.width,
      height: atlas.height,
      frames: Object.fromEntries(
        atlas.frames.map((f) => {
          const s = byId.get(f.id);
          return [
            s?.name ?? f.id,
            {
              frame: { x: f.x, y: f.y, w: f.width, h: f.height },
              trimmed: f.trimmed !== undefined,
              sourceSize: f.trimmed
                ? { w: f.trimmed.sourceWidth, h: f.trimmed.sourceHeight }
                : { w: f.width, h: f.height },
              spriteSourceSize: f.trimmed
                ? {
                    x: f.trimmed.offsetX,
                    y: f.trimmed.offsetY,
                    w: f.width,
                    h: f.height,
                  }
                : { x: 0, y: 0, w: f.width, h: f.height },
            },
          ];
        }),
      ),
    };
  }, [atlas, sprites]);

  const downloadAtlas = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "atlas.png";
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Atlas PNG downloaded");
    }, "image/png");
  };

  const downloadJson = () => {
    if (!jsonPayload) return;
    const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atlas.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Atlas JSON downloaded");
  };

  const copyJson = async () => {
    if (!jsonPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonPayload, null, 2));
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  const efficiency = useMemo(() => {
    if (!atlas) return 0;
    const total = atlas.width * atlas.height;
    if (total === 0) return 0;
    let used = 0;
    for (const f of atlas.frames) used += f.width * f.height;
    return (used / total) * 100;
  }, [atlas]);

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Atlas"
        description="Upload multiple sprites — trim, bin-pack, export PNG + JSON manifest."
        icon={Boxes}
        category="export"
        docs="atlas"
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Sprites</CardTitle>
              <CardDescription className="text-xs">
                Drop or pick multiple image files. Add more at any time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={cn(
                  "border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer transition-colors p-6",
                  isDragging && "border-primary bg-primary/10",
                  "border-muted-foreground/20 hover:border-primary/50",
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
              >
                <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  Upload / drop multiple images
                </p>
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={onFileInputChange}
                />
              </div>

              {sprites.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {sprites.length} sprite{sprites.length === 1 ? "" : "s"}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive"
                      onClick={clearAll}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Clear
                    </Button>
                  </div>
                  <div className="space-y-1 max-h-60 overflow-y-auto border rounded-md p-1">
                    {sprites.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-2 p-1 rounded hover:bg-muted/30 text-xs"
                      >
                        <div
                          className={cn(
                            "w-8 h-8 shrink-0 border rounded overflow-hidden",
                            gridTheme === "light"
                              ? "checkerboard-light"
                              : "checkerboard-dark",
                          )}
                        >
                          <SpriteThumb data={s.content} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="truncate font-mono text-[10px]">{s.name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {s.content.width}×{s.content.height}
                            {s.trim && s.trim.w !== s.fullWidth && (
                              <span className="opacity-60">
                                {" "}
                                (from {s.fullWidth}×{s.fullHeight})
                              </span>
                            )}
                          </p>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 opacity-50 hover:opacity-100"
                          onClick={() => removeSprite(s.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Pack settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label className="text-xs">Padding</Label>
                  <span className="text-[10px] font-mono">{padding}px</span>
                </div>
                <Slider
                  value={[padding]}
                  min={0}
                  max={16}
                  step={1}
                  onValueChange={(v) => setPadding(Array.isArray(v) ? v[0] : v)}
                />
                <p className="text-[10px] text-muted-foreground">
                  Gutter between sprites (prevents bleeding).
                </p>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Power-of-2 size</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Round atlas dimensions up to 2ⁿ — required by some GPUs.
                  </p>
                </div>
                <Switch checked={pow2} onCheckedChange={setPow2} />
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Auto-trim transparent</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Clip each sprite to its opaque bounds before packing. Toggle then re-upload to re-apply.
                  </p>
                </div>
                <Switch checked={autoTrim} onCheckedChange={setAutoTrim} />
              </div>
            </CardContent>
          </Card>

          {atlas && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" /> Export
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-muted-foreground border rounded-md p-2 bg-muted/20">
                  <div>
                    <div className="opacity-60">Size</div>
                    <div className="text-foreground text-sm font-bold">
                      {atlas.width}×{atlas.height}
                    </div>
                  </div>
                  <div>
                    <div className="opacity-60">Fill</div>
                    <div className="text-foreground text-sm font-bold">
                      {efficiency.toFixed(0)}%
                    </div>
                  </div>
                </div>
                <Button onClick={downloadAtlas} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download atlas.png
                </Button>
                <Button onClick={downloadJson} variant="outline" className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download atlas.json
                </Button>
                <Button onClick={copyJson} variant="ghost" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy JSON
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-8 space-y-6">
          <Card className="shadow-lg ring-1 ring-primary/10">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Atlas preview</CardTitle>
                {isLoading && (
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
                onZoomIn={() => atlas && viewport.setZoomIn(atlas.width, atlas.height)}
                onZoomOut={() => atlas && viewport.setZoomOut(atlas.width, atlas.height)}
                onReset={() => atlas && viewport.fitToView(atlas.width, atlas.height)}
              />
            </CardHeader>
            <CardContent>
              <div
                ref={previewContainerRef}
                className={cn(
                  "aspect-video min-h-96 rounded-lg border overflow-hidden relative cursor-move touch-none",
                  gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                )}
              >
                {atlas ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: atlas.width,
                        height: atlas.height,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <canvas
                        ref={canvasRef}
                        className="block"
                        style={{
                          width: atlas.width,
                          height: atlas.height,
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
                      {atlas.frames.length} frames · {atlas.width}×{atlas.height}
                    </div>
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Boxes className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">Upload sprites to build an atlas</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

// -----------------------------------------------------------------
// Thumbnail
// -----------------------------------------------------------------
function SpriteThumb({ data }: { data: ImageData }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(data, 0, 0);
  }, [data]);
  return (
    <canvas
      ref={ref}
      className="w-full h-full object-contain"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
