"use client";

import * as React from "react";
import { useRef, useState } from "react";
import { Upload, Loader2, Scissors, Grid3x3, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ensurePreviewUrl, type Frame } from "@/lib/pipeline/types";

// -----------------------------------------------------------------
// <FrameImg>: render a pipeline Frame as an <img> with lazy preview URL.
// -----------------------------------------------------------------

export function FrameImg({
  frame,
  ...rest
}: {
  frame: Frame;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  // Prefer the synchronous previewUrl when the frame already has one;
  // only fall back to the async ensurePreviewUrl when it doesn't. Splitting
  // out the sync path as derived state avoids setState-in-effect.
  const syncUrl = frame.previewUrl ?? null;
  const [asyncUrl, setAsyncUrl] = useState<string | null>(null);
  React.useEffect(() => {
    if (syncUrl) return; // nothing to fetch
    let active = true;
    ensurePreviewUrl(frame).then((u) => {
      if (active) setAsyncUrl(u);
    });
    return () => {
      active = false;
    };
  }, [frame, syncUrl]);
  const url = syncUrl ?? asyncUrl;
  if (!url) return null;
  return <img src={url} alt="" {...rest} />;
}

export interface UploadZoneDragProps {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface UploadZoneProps {
  isDragging: boolean;
  hasFile: boolean;
  children: React.ReactNode;
  onChange: (files: File[]) => void;
  multiple?: boolean;
  accept: string;
  uploadZoneProps: UploadZoneDragProps;
}

export function UploadZone({
  isDragging,
  hasFile,
  children,
  onChange,
  multiple = false,
  accept,
  uploadZoneProps,
}: UploadZoneProps) {
  const inputId = React.useId();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: container intercepts events; not a control
    // biome-ignore lint/a11y/useKeyWithClickEvents: file drop zone — click forwards to nested <input type="file">; keyboard a11y tracked separately
    <div
      className={cn(
        "border-2 border-dashed rounded-lg overflow-hidden flex flex-col items-center justify-center cursor-pointer transition-colors relative",
        isDragging && "border-primary bg-primary/10",
        hasFile
          ? "border-primary/50 aspect-video"
          : "border-muted-foreground/20 hover:border-primary/50 p-6",
      )}
      onClick={() => document.getElementById(inputId)?.click()}
      {...uploadZoneProps}
    >
      {children}
      <Input
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onChange(files);
        }}
      />
    </div>
  );
}

export interface SheetPreviewWithGridProps {
  src: string;
  cols: number;
  rows: number;
}

export function SheetPreviewWithGrid({ src, cols, rows }: SheetPreviewWithGridProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);

  React.useLayoutEffect(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const compute = () => {
      const ir = img.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      setBox({
        left: ir.left - cr.left,
        top: ir.top - cr.top,
        w: ir.width,
        h: ir.height,
      });
    };
    const onLoad = () => compute();
    if (img.complete) compute();
    img.addEventListener("load", onLoad);
    const ro = new ResizeObserver(compute);
    ro.observe(img);
    ro.observe(container);
    return () => {
      img.removeEventListener("load", onLoad);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center bg-black/5"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt="Sheet preview"
        className="max-w-full max-h-full object-contain"
      />
      {box && (cols > 1 || rows > 1) && (
        <div
          className="absolute pointer-events-none"
          style={{ left: box.left, top: box.top, width: box.w, height: box.h }}
        >
          {Array.from({ length: cols - 1 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional grid line, never reordered
              key={`c${i}`}
              className="absolute top-0 bottom-0 bg-primary/80 shadow-[0_0_3px_rgba(0,0,0,0.6)]"
              style={{ left: `${((i + 1) / cols) * 100}%`, width: 1 }}
            />
          ))}
          {Array.from({ length: rows - 1 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional grid line, never reordered
              key={`r${i}`}
              className="absolute left-0 right-0 bg-primary/80 shadow-[0_0_3px_rgba(0,0,0,0.6)]"
              style={{ top: `${((i + 1) / rows) * 100}%`, height: 1 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Source tab bodies
// -----------------------------------------------------------------

export interface VideoSourceProps {
  videoUrl: string | null;
  fps: number;
  setFps: (n: number) => void;
  uploadZoneProps: UploadZoneDragProps;
  isDragging: boolean;
  onFile: (f: File) => void;
  onRun: () => void;
  running: boolean;
  progressLabel: string;
  progressPct: number;
}

export function VideoSource({
  videoUrl,
  fps,
  setFps,
  uploadZoneProps,
  isDragging,
  onFile,
  onRun,
  running,
  progressLabel,
  progressPct,
}: VideoSourceProps) {
  return (
    <div className="space-y-4">
      <UploadZone
        isDragging={isDragging}
        hasFile={!!videoUrl}
        uploadZoneProps={uploadZoneProps}
        accept="video/*"
        onChange={(files) => onFile(files[0])}
      >
        {videoUrl ? (
          <video src={videoUrl} className="w-full h-full object-cover" muted loop autoPlay />
        ) : (
          <div className="text-center">
            <Upload className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
            <p className="text-sm text-muted-foreground">Upload / drop / paste video</p>
          </div>
        )}
      </UploadZone>
      <div className="space-y-3">
        <div className="flex justify-between">
          <Label>Extraction FPS</Label>
          <span className="text-sm font-medium bg-muted px-2 py-0.5 rounded">{fps}</span>
        </div>
        <Slider
          value={[fps]}
          min={1}
          max={60}
          step={1}
          onValueChange={(v) => setFps(Array.isArray(v) ? v[0] : v)}
        />
      </div>
      <Button onClick={onRun} disabled={running || !videoUrl} className="w-full">
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Scissors className="mr-2 h-4 w-4" />
        )}
        Extract Raw Frames
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
  );
}

export interface SheetSourceProps {
  sheetUrl: string | null;
  cols: number;
  rows: number;
  setCols: (n: number) => void;
  setRows: (n: number) => void;
  detected: { cols: number; rows: number } | null;
  uploadZoneProps: UploadZoneDragProps;
  isDragging: boolean;
  onFile: (f: File) => void;
  onRun: () => void;
  running: boolean;
  progressLabel: string;
  progressPct: number;
}

export function SheetSource({
  sheetUrl,
  cols,
  rows,
  setCols,
  setRows,
  detected,
  uploadZoneProps,
  isDragging,
  onFile,
  onRun,
  running,
  progressLabel,
  progressPct,
}: SheetSourceProps) {
  return (
    <div className="space-y-4">
      <UploadZone
        isDragging={isDragging}
        hasFile={!!sheetUrl}
        uploadZoneProps={uploadZoneProps}
        accept="image/*"
        onChange={(files) => onFile(files[0])}
      >
        {sheetUrl ? (
          <SheetPreviewWithGrid src={sheetUrl} cols={cols} rows={rows} />
        ) : (
          <div className="text-center">
            <Grid3x3 className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
            <p className="text-sm text-muted-foreground">Upload / drop sprite sheet image</p>
          </div>
        )}
      </UploadZone>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Columns</Label>
          <Input
            type="number"
            min={1}
            value={cols}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n > 0) setCols(n);
            }}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Rows</Label>
          <Input
            type="number"
            min={1}
            value={rows}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n > 0) setRows(n);
            }}
            className="h-8 text-sm"
          />
        </div>
      </div>
      {detected && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Wand2 className="w-3 h-3" />
          Auto-detected {detected.cols}×{detected.rows}
        </p>
      )}
      <Button onClick={onRun} disabled={running || !sheetUrl} className="w-full">
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Grid3x3 className="mr-2 h-4 w-4" />
        )}
        Split Sheet
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
  );
}
