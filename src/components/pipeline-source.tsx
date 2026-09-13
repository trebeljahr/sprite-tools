"use client";

import * as React from "react";
import { useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Scissors,
  Grid3x3,
  Layers,
  TriangleAlert,
  Wand2,
  ChevronRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  type CellGeometry,
  cellRect,
  computeCellGeometry,
  type GridMargin,
  type GridSpacing,
  isZeroPadding,
  ZERO_PADDING,
} from "@/lib/pipeline/grid";
import type { AseDocument } from "@/lib/aseprite/types";
import { asepriteLayerChoices, readAsepriteMeta, toggleAsepriteLayer } from "@/lib/pipeline/import";
import { type AsepriteImportConfig, ensurePreviewUrl, type Frame } from "@/lib/pipeline/types";

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
  /** Real cut geometry. Given a padded one, the overlay draws both edges of every
   *  cell so the lines land on the gutters; without it, even lines as before. */
  geom?: CellGeometry | null;
  sheetSize?: { width: number; height: number } | null;
}

export function SheetPreviewWithGrid({
  src,
  cols,
  rows,
  geom,
  sheetSize,
}: SheetPreviewWithGridProps) {
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

  // Padded sheets get explicit per-cell edges; flush ones keep the single-line
  // overlay they have always had.
  const cut = geom && sheetSize && !isZeroPadding(geom.padding) ? { geom, size: sheetSize } : null;
  const edges = (count: number, axis: "x" | "y") => {
    if (!cut) return [];
    const size = axis === "x" ? cut.size.width : cut.size.height;
    const cell = axis === "x" ? cut.geom.cellW : cut.geom.cellH;
    return Array.from({ length: count }, (_, i) => {
      const start = axis === "x" ? cellRect(cut.geom, i, 0).x : cellRect(cut.geom, 0, i).y;
      return [(start / size) * 100, ((start + cell) / size) * 100];
    }).flat();
  };

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
      {box && cut && (
        <div
          className="absolute pointer-events-none"
          style={{ left: box.left, top: box.top, width: box.w, height: box.h }}
        >
          {edges(cols, "x").map((pct, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional grid line, never reordered
              key={`cx${i}`}
              className="absolute top-0 bottom-0 bg-primary/80 shadow-[0_0_3px_rgba(0,0,0,0.6)]"
              style={{ left: `${pct}%`, width: 1 }}
            />
          ))}
          {edges(rows, "y").map((pct, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: positional grid line, never reordered
              key={`cy${i}`}
              className="absolute left-0 right-0 bg-primary/80 shadow-[0_0_3px_rgba(0,0,0,0.6)]"
              style={{ top: `${pct}%`, height: 1 }}
            />
          ))}
        </div>
      )}
      {box && !cut && (cols > 1 || rows > 1) && (
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

/** "margin 1, spacing 2" — empty when flush, so a flush hint reads exactly as before. */
export function describeGridPadding(margin?: GridMargin, spacing?: GridSpacing): string {
  const parts: string[] = [];
  if (margin && (margin.left || margin.top || margin.right || margin.bottom)) {
    const { left, top, right, bottom } = margin;
    const uniform = left === top && top === right && right === bottom;
    parts.push(uniform ? `margin ${left}` : `margin L${left} T${top} R${right} B${bottom}`);
  }
  if (spacing && (spacing.x || spacing.y)) {
    const { x, y } = spacing;
    parts.push(x === y ? `spacing ${x}` : `spacing ${x}×${y}`);
  }
  return parts.join(", ");
}

function NumField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= min) onChange(n);
        }}
        className="h-8 text-sm"
      />
    </div>
  );
}

export interface SheetSourceProps {
  sheetUrl: string | null;
  cols: number;
  rows: number;
  setCols: (n: number) => void;
  setRows: (n: number) => void;
  /** Cut padding. Pages that don't hold this state omit the setters and the
   *  panel stays flush-only — no disclosure, no extra fields. */
  margin?: GridMargin;
  spacing?: GridSpacing;
  setMargin?: (m: GridMargin) => void;
  setSpacing?: (s: GridSpacing) => void;
  detected: { cols: number; rows: number; margin?: GridMargin; spacing?: GridSpacing } | null;
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
  margin = ZERO_PADDING.margin,
  spacing = ZERO_PADDING.spacing,
  setMargin,
  setSpacing,
  detected,
  uploadZoneProps,
  isDragging,
  onFile,
  onRun,
  running,
  progressLabel,
  progressPct,
}: SheetSourceProps) {
  // The fit check and the overlay both need the sheet's real pixel size, and a
  // blob URL is all we get handed.
  const [sheetSize, setSheetSize] = useState<{ width: number; height: number } | null>(null);
  React.useEffect(() => {
    setSheetSize(null);
    if (!sheetUrl) return;
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active) setSheetSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = sheetUrl;
    return () => {
      active = false;
    };
  }, [sheetUrl]);

  const fit = React.useMemo(() => {
    if (!sheetSize) return { geom: null, error: null };
    try {
      const geom = computeCellGeometry(sheetSize.width, sheetSize.height, cols, rows, {
        margin,
        spacing,
      });
      return { geom, error: null };
    } catch (e) {
      return { geom: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [sheetSize, cols, rows, margin, spacing]);

  const editable = !!setMargin && !!setSpacing;
  const summary = describeGridPadding(margin, spacing);
  const detectedPadding = describeGridPadding(detected?.margin, detected?.spacing);
  const [showPadding, setShowPadding] = useState(false);
  // A fresh detection re-decides the disclosure: open when it found padding (the
  // user needs to see and correct the numbers about to be used), closed for a
  // flush sheet so the common case keeps the two-field panel it always had.
  const [lastDetected, setLastDetected] = useState(detected);
  if (detected !== lastDetected) {
    setLastDetected(detected);
    setShowPadding(!!detectedPadding);
  }

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
          <SheetPreviewWithGrid
            src={sheetUrl}
            cols={cols}
            rows={rows}
            geom={fit.geom}
            sheetSize={sheetSize}
          />
        ) : (
          <div className="text-center">
            <Grid3x3 className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
            <p className="text-sm text-muted-foreground">Upload / drop sprite sheet image</p>
          </div>
        )}
      </UploadZone>
      <div className="grid grid-cols-2 gap-3">
        <NumField label="Columns" value={cols} onChange={setCols} min={1} />
        <NumField label="Rows" value={rows} onChange={setRows} min={1} />
      </div>
      {editable && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowPadding((v) => !v)}
            aria-expanded={showPadding}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={cn("w-3 h-3 transition-transform", showPadding && "rotate-90")}
            />
            Margin &amp; spacing
            {!showPadding && summary && <span className="font-mono">· {summary}</span>}
          </button>
          {showPadding && (
            <div className="grid grid-cols-2 gap-3">
              <NumField
                label="Margin left"
                value={margin.left}
                onChange={(n) => setMargin?.({ ...margin, left: n })}
              />
              <NumField
                label="Margin top"
                value={margin.top}
                onChange={(n) => setMargin?.({ ...margin, top: n })}
              />
              <NumField
                label="Margin right"
                value={margin.right}
                onChange={(n) => setMargin?.({ ...margin, right: n })}
              />
              <NumField
                label="Margin bottom"
                value={margin.bottom}
                onChange={(n) => setMargin?.({ ...margin, bottom: n })}
              />
              <NumField
                label="Spacing X"
                value={spacing.x}
                onChange={(n) => setSpacing?.({ ...spacing, x: n })}
              />
              <NumField
                label="Spacing Y"
                value={spacing.y}
                onChange={(n) => setSpacing?.({ ...spacing, y: n })}
              />
            </div>
          )}
        </div>
      )}
      {detected && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Wand2 className="w-3 h-3" />
          Auto-detected {detected.cols}×{detected.rows}
          {detectedPadding && `, ${detectedPadding}`}
        </p>
      )}
      {fit.error && <p className="text-[11px] text-destructive leading-relaxed">{fit.error}</p>}
      <Button onClick={onRun} disabled={running || !sheetUrl || !!fit.error} className="w-full">
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

// -----------------------------------------------------------------
// Aseprite source
// -----------------------------------------------------------------
// Unlike the other two sources this one has to parse its file before it can
// render anything — an .ase has no <img>/<video> preview and the layer and tag
// pickers only exist once the document is known. That parse-plus-options state
// is identical on every page that offers the tab, so it lives in a hook here
// rather than being copy-pasted into each page.

export interface AsepriteSourceState {
  file: File | null;
  /** The parsed document for `file` — never a previous file's. */
  doc: AseDocument | null;
  error: string | null;
  parsing: boolean;
  includeHidden: boolean;
  setIncludeHidden: (v: boolean) => void;
  /** null means every layer; never an empty array. */
  layerNames: string[] | null;
  toggleLayer: (name: string) => void;
  tag: string | null;
  setTag: (v: string | null) => void;
  config: AsepriteImportConfig;
  pick: (f: File) => void;
  clear: () => void;
}

export interface UseAsepriteSourceOptions {
  /**
   * Called from the event handler of every include-hidden / layer / tag change
   * with the resulting config and the file it applies to, so a page can push
   * it into an import step that already ran. Deliberately not an effect that
   * mirrors state into the pipeline: an effect would fight undo, re-applying
   * the picker's config the moment undo restores an older one.
   */
  onConfigChange?: (config: AsepriteImportConfig, file: File) => void;
}

const ALL_TAGS = "__all__";

function toConfig(
  includeHidden: boolean,
  layerNames: string[] | null,
  tag: string | null,
): AsepriteImportConfig {
  return {
    includeHiddenLayers: includeHidden,
    layerNames: layerNames ?? undefined,
    tag: tag ?? undefined,
  };
}

type ParseResult =
  | { file: File; doc: AseDocument; error: null }
  | { file: File; doc: null; error: string };

export function useAsepriteSource(options: UseAsepriteSourceOptions = {}): AsepriteSourceState {
  const { onConfigChange } = options;
  const [file, setFile] = useState<File | null>(null);
  // The parse result remembers which File it belongs to. `doc`, `error` and
  // `parsing` are derived by comparing it against the current file, so a slow
  // parse of an earlier pick can never show up as the newer file's document,
  // and picking a new file hides the old layers immediately.
  const [result, setResult] = useState<ParseResult | null>(null);
  const [includeHidden, setIncludeHiddenState] = useState(false);
  const [layerNames, setLayerNames] = useState<string[] | null>(null);
  const [tag, setTagState] = useState<string | null>(null);

  React.useEffect(() => {
    if (!file) return;
    let active = true;
    readAsepriteMeta(file)
      .then((doc) => {
        if (active) setResult({ file, doc, error: null });
      })
      .catch((e: unknown) => {
        if (active) {
          setResult({ file, doc: null, error: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      active = false;
    };
  }, [file]);

  const current = result && result.file === file ? result : null;
  const doc = current?.doc ?? null;
  const error = current?.error ?? null;
  const parsing = file !== null && current === null;

  const pick = React.useCallback((f: File) => {
    setFile(f);
    setLayerNames(null);
    setTagState(null);
  }, []);

  const clear = React.useCallback(() => {
    setFile(null);
    setResult(null);
    setLayerNames(null);
    setTagState(null);
  }, []);

  const notify = (config: AsepriteImportConfig) => {
    if (file && doc) onConfigChange?.(config, file);
  };

  const setIncludeHidden = (v: boolean) => {
    setIncludeHiddenState(v);
    notify(toConfig(v, layerNames, tag));
  };

  const toggleLayer = (name: string) => {
    if (!doc) return;
    const next = toggleAsepriteLayer(layerNames, name, asepriteLayerChoices(doc, includeHidden));
    if (next === layerNames) return;
    setLayerNames(next);
    notify(toConfig(includeHidden, next, tag));
  };

  const setTag = (v: string | null) => {
    setTagState(v);
    notify(toConfig(includeHidden, layerNames, v));
  };

  return {
    file,
    doc,
    error,
    parsing,
    includeHidden,
    setIncludeHidden,
    layerNames,
    toggleLayer,
    tag,
    setTag,
    config: toConfig(includeHidden, layerNames, tag),
    pick,
    clear,
  };
}

export interface AsepriteSourceProps {
  state: AsepriteSourceState;
  uploadZoneProps: UploadZoneDragProps;
  isDragging: boolean;
  /** The page's own handler, so a file picked here resets the same page state a dropped one does. */
  onFile: (f: File) => void;
  onRun: () => void;
  running: boolean;
  progressLabel: string;
  progressPct: number;
}

export function AsepriteSource({
  state,
  uploadZoneProps,
  isDragging,
  onFile,
  onRun,
  running,
  progressLabel,
  progressPct,
}: AsepriteSourceProps) {
  const { doc, file, error, parsing, layerNames } = state;
  const layerChoices = doc ? asepriteLayerChoices(doc, state.includeHidden) : [];
  const isLayerOn = (name: string) => layerNames === null || layerNames.includes(name);

  // The importer and compositor append to `doc.warnings` in place (group blend
  // modes that got flattened, cels it had to skip, a clamped tag), so notes
  // that only exist after a run never reach the DOM off an unchanged `doc`
  // reference. Re-snapshot whenever a run ends. The snapshot remembers its
  // document: comparing lengths alone would keep showing the previous file's
  // notes when the new file happens to have the same number of them.
  const [warningSnapshot, setWarningSnapshot] = useState<{
    doc: AseDocument | null;
    list: string[];
  }>({ doc: null, list: [] });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `running` is the trigger, not a value read here — the importer only appends while a run is in flight
  React.useEffect(() => {
    setWarningSnapshot((prev) =>
      prev.doc === doc && prev.list.length === (doc?.warnings.length ?? 0)
        ? prev
        : { doc, list: doc ? [...doc.warnings] : [] },
    );
  }, [doc, running]);
  const warnings =
    warningSnapshot.doc === doc ? warningSnapshot.list : doc ? [...doc.warnings] : [];

  return (
    <div className="space-y-4">
      <UploadZone
        isDragging={isDragging}
        hasFile={false}
        uploadZoneProps={uploadZoneProps}
        accept=".ase,.aseprite"
        onChange={(files) => onFile(files[0])}
      >
        <div className="text-center">
          <Layers className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
          <p className="text-sm text-muted-foreground">
            {file ? file.name : "Upload / drop .ase or .aseprite"}
          </p>
        </div>
      </UploadZone>

      {parsing && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Reading document…
        </p>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {doc && (
        <>
          <div className="rounded-md border bg-muted/20 px-3 py-2 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Canvas</span>
              <span className="font-medium">
                {doc.width}×{doc.height}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Frames</span>
              <span className="font-medium">{doc.frameCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Colour depth</span>
              <span className="font-medium">
                {doc.colorDepth} bpp
                {doc.colorDepth === 8 ? ` · ${doc.palette.length}-colour palette` : ""}
              </span>
            </div>
          </div>

          {layerChoices.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                Layers
                {layerNames
                  ? ` (${layerNames.length}/${layerChoices.filter((c) => !c.disabledReason).length})`
                  : ""}
              </Label>
              <div className="flex flex-wrap gap-1">
                {layerChoices.map((c) => (
                  <button
                    type="button"
                    key={c.index}
                    // aria-disabled, not disabled: a disabled button swallows the
                    // hover in some browsers, and the title is the only place the
                    // reason is shown. toggleLayer ignores these clicks anyway.
                    onClick={() => state.toggleLayer(c.name)}
                    aria-disabled={!!c.disabledReason}
                    title={c.disabledReason ? `${c.name}: ${c.disabledReason}` : c.name}
                    className={cn(
                      "px-2 py-0.5 rounded border text-[11px] transition-colors",
                      c.disabledReason
                        ? "border-dashed border-muted-foreground/20 text-muted-foreground/60 italic cursor-not-allowed"
                        : isLayerOn(c.name)
                          ? "bg-primary/10 border-primary/40 text-foreground"
                          : "border-muted-foreground/20 text-muted-foreground line-through",
                    )}
                  >
                    {"·".repeat(c.childLevel)}
                    {c.name}
                  </button>
                ))}
              </div>
              {layerChoices.some((c) => c.disabledReason) && (
                <p className="text-[10px] text-muted-foreground">
                  Dashed layers cannot add pixels to the import. Hover one to see why.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <Label className="text-xs" htmlFor="ase-hidden">
              Include hidden layers
            </Label>
            <Switch
              id="ase-hidden"
              checked={state.includeHidden}
              onCheckedChange={state.setIncludeHidden}
            />
          </div>

          {doc.tags.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Animation tag</Label>
              <Select
                value={state.tag ?? ALL_TAGS}
                onValueChange={(v) => state.setTag(v === ALL_TAGS ? null : v)}
              >
                <SelectTrigger className="h-8 text-sm">
                  {/* Base UI renders the raw value unless told the label, which
                      would show the ALL_TAGS sentinel to the user. */}
                  <SelectValue>
                    {(v: string) => {
                      if (v === ALL_TAGS) return `All frames (${doc.frameCount})`;
                      const t = doc.tags.find((tag) => tag.name === v);
                      return t ? `${t.name} · ${t.from}–${t.to} · ${t.direction}` : v;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_TAGS}>All frames ({doc.frameCount})</SelectItem>
                  {doc.tags.map((t) => (
                    <SelectItem key={`${t.name}-${t.from}`} value={t.name}>
                      {t.name} · {t.from}–{t.to} · {t.direction}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <TriangleAlert className="w-3 h-3" />
                Decode notes
              </p>
              <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <Button onClick={onRun} disabled={running || !doc} className="w-full">
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Layers className="mr-2 h-4 w-4" />
        )}
        Import Frames
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
