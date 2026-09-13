"use client";

// Sheet Lint — run the linter in the browser and draw its findings ON the sheet.
//
// The linter already emits SHEET-ABSOLUTE `at` / `region` coordinates, so the
// overlay is a plain SVG sitting on top of the sheet image at 1:1 sheet pixels;
// the pan/zoom transform lives on their shared wrapper. That is the whole point
// of this page: a JSON report tells you "frame 7 bleeds into frame 8", the
// overlay shows you where.
//
// lintSheet() is DOM-free and synchronous — one sheet is fast enough to run on
// the render path, so there is no worker and no progress bar here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Info,
  Palette,
  RotateCcw,
  Sparkles,
  Stethoscope,
  Terminal,
  Upload,
  Wand2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { JsonPreview } from "@/components/json-preview";
import { SampleSprites } from "@/components/sample-sprites";
import { SourceBanner } from "@/components/source-banner";
import { ToolHeader } from "@/components/tool-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ViewportControls, ZoomIndicator } from "@/components/viewport-controls";
import { useViewport } from "@/hooks/use-viewport";
import { track } from "@/lib/analytics";
import {
  type DeepPartial,
  type Finding,
  type LintConfig,
  type LintReport,
  lintSheet,
  RULE_DOCS,
  RULE_IDS,
  type RuleId,
  type Severity,
} from "@/lib/lint";
import type { GridPadding } from "@/lib/pipeline/grid";
import { useSharedProjectSource } from "@/lib/project/store";
import { cn } from "@/lib/utils";

// Overlay + chip colours per severity. Hex (not Tailwind classes) for the SVG
// side because stroke/fill need literal values.
const SEVERITY_STYLE: Record<
  Severity,
  { stroke: string; fill: string; chip: string; Icon: typeof XCircle; label: string }
> = {
  error: {
    stroke: "#ef4444",
    fill: "rgba(239, 68, 68, 0.18)",
    chip: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    Icon: XCircle,
    label: "error",
  },
  warning: {
    stroke: "#f59e0b",
    fill: "rgba(245, 158, 11, 0.18)",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    Icon: AlertTriangle,
    label: "warning",
  },
  info: {
    stroke: "#38bdf8",
    fill: "rgba(56, 189, 248, 0.16)",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
    Icon: Info,
    label: "info",
  },
};

async function fileToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close?.();
    throw new Error("2D canvas context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export default function LintPage() {
  const { sourceFile, sourceUrl, setSharedSource } = useSharedProjectSource();

  const [sheet, setSheet] = useState<ImageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Grid: the linter auto-detects by default. The override exists because a
  // wrong detection makes frame-bleed and empty-cell noisy, and telling the
  // linter the truth is cheaper than muting the rules.
  const [gridOverride, setGridOverride] = useState(false);
  const [cols, setCols] = useState(1);
  const [rows, setRows] = useState(1);

  const [disabled, setDisabled] = useState<ReadonlySet<RuleId>>(() => new Set<RuleId>());
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [gridTheme, setGridTheme] = useState<"light" | "dark">("light");
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());

  const viewport = useViewport();
  const { view, baseView, containerRef: previewContainerRef } = viewport;
  const hasAutoFittedRef = useRef(false);

  // -----------------------------------------------------------------
  // Source → ImageData
  // -----------------------------------------------------------------

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Please upload an image file.");
        return;
      }
      await setSharedSource(file);
    },
    [setSharedSource],
  );

  useEffect(() => {
    if (!sourceFile) {
      setSheet(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    fileToImageData(sourceFile)
      .then((data) => {
        if (cancelled) return;
        setSheet(data);
        setSelected(null);
        setGridOverride(false);
        hasAutoFittedRef.current = false;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSheet(null);
        setLoadError(e instanceof Error ? e.message : String(e));
        toast.error("Could not read that image");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceFile]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = e.clipboardData?.items[0];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) void handleFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  // -----------------------------------------------------------------
  // Lint — derived state, so toggling a rule re-lints without an effect
  // -----------------------------------------------------------------

  // Null unless the user is overriding, so editing the (hidden) cols/rows
  // inputs can never invalidate an auto-detected report — which matters
  // because the seeding effect below writes to those very inputs.
  const explicitCols = gridOverride ? Math.max(1, cols) : null;
  const explicitRows = gridOverride ? Math.max(1, rows) : null;
  const [detectedPadding, setDetectedPadding] = useState<GridPadding | null>(null);
  const overridePadding = gridOverride ? detectedPadding : null;

  const result = useMemo<{ report: LintReport | null; error: string | null }>(() => {
    if (!sheet || !sourceFile) return { report: null, error: null };
    const rules: NonNullable<DeepPartial<LintConfig>["rules"]> = {};
    for (const id of RULE_IDS) {
      if (disabled.has(id)) rules[id] = { enabled: false };
    }
    try {
      return {
        report: lintSheet({
          source: sourceFile.name,
          image: sheet,
          // Overriding the grid skips detection, so carry the padding detection
          // last read — otherwise a padded tileset would be re-cut flush.
          ...(explicitCols !== null && explicitRows !== null
            ? { cols: explicitCols, rows: explicitRows, padding: overridePadding }
            : {}),
          config: { rules },
        }),
        error: null,
      };
    } catch (e) {
      return { report: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [sheet, sourceFile, disabled, explicitCols, explicitRows, overridePadding]);

  const report = result.report;

  // Seed the manual grid inputs from whatever the linter detected, so flipping
  // the override on starts from the detected grid rather than 1x1.
  useEffect(() => {
    if (gridOverride || !report) return;
    setCols(report.grid.cols);
    setRows(report.grid.rows);
    setDetectedPadding({ margin: report.grid.margin, spacing: report.grid.spacing });
  }, [report, gridOverride]);

  useEffect(() => {
    if (!report) return;
    track("lint_run", {
      tool: "lint",
      frames: report.summary.frameCount,
      errors: report.summary.errors,
      warnings: report.summary.warnings,
      infos: report.summary.infos,
      rulesRun: report.summary.rulesRun.length,
    });
  }, [report]);

  const findings = report?.findings ?? [];

  // Clear a stale selection when the finding list changes shape under it.
  useEffect(() => {
    setSelected((s) => (s !== null && s >= findings.length ? null : s));
  }, [findings.length]);

  const findingCountByRule = useMemo(() => {
    const counts = new Map<RuleId, number>();
    for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
    return counts;
  }, [findings]);

  const skipReasonByRule = useMemo(() => {
    const map = new Map<RuleId, string>();
    for (const s of report?.summary.rulesSkipped ?? []) map.set(s.rule, s.reason);
    return map;
  }, [report]);

  // -----------------------------------------------------------------
  // Viewport wiring
  // -----------------------------------------------------------------

  useEffect(() => {
    if (!sheet || hasAutoFittedRef.current || !previewContainerRef.current) return;
    const t = setTimeout(() => {
      viewport.fitToView(sheet.width, sheet.height);
      hasAutoFittedRef.current = true;
    }, 100);
    return () => clearTimeout(t);
  }, [sheet, viewport, previewContainerRef]);

  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewport.handleWheel(e, el);
    };
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", prevent, { passive: false });
    el.addEventListener("gesturechange", prevent, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", prevent);
      el.removeEventListener("gesturechange", prevent);
    };
  }, [viewport, previewContainerRef]);

  // -----------------------------------------------------------------
  // Interactions
  // -----------------------------------------------------------------

  const selectFinding = useCallback((index: number) => {
    setSelected(index);
    rowRefs.current.get(index)?.scrollIntoView({ block: "nearest" });
  }, []);

  const toggleRule = useCallback((id: RuleId) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(null);
  }, []);

  // -----------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------

  const cliCommand = useMemo(() => {
    const name = sourceFile?.name ?? "sheet.png";
    const parts = ["sprite-tools lint", name];
    if (gridOverride) {
      parts.push(`--cols ${Math.max(1, cols)}`, `--rows ${Math.max(1, rows)}`);
      // Flags are per axis, so an asymmetric detected border has no spelling —
      // leave it out and the CLI's result will show the difference.
      const p = detectedPadding;
      if (p && p.margin.left === p.margin.right && p.margin.left > 0) {
        parts.push(`--margin-x ${p.margin.left}`);
      }
      if (p && p.margin.top === p.margin.bottom && p.margin.top > 0) {
        parts.push(`--margin-y ${p.margin.top}`);
      }
      if (p && p.spacing.x > 0) parts.push(`--spacing-x ${p.spacing.x}`);
      if (p && p.spacing.y > 0) parts.push(`--spacing-y ${p.spacing.y}`);
    }
    for (const id of RULE_IDS) if (disabled.has(id)) parts.push(`--disable ${id}`);
    return parts.join(" ");
  }, [sourceFile, gridOverride, cols, rows, disabled, detectedPadding]);

  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      toast.success("CLI command copied");
    } catch {
      toast.error("Clipboard copy failed");
    }
  };

  const downloadJson = () => {
    if (!report || !sourceFile) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sourceFile.name.replace(/\.[^.]+$/, "")}-lint.json`;
    a.click();
    URL.revokeObjectURL(url);
    track("export", { tool: "lint", format: "json", findings: report.findings.length });
    toast.success("Lint report downloaded");
  };

  const copyJson = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast.success("Copied report to clipboard");
    } catch {
      toast.error("Clipboard copy failed");
    }
  };

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  const active = hovered ?? selected;
  const strokeWidth = Math.max(0.35, 1.5 / Math.max(view.zoom, 0.0001));

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Sheet Lint"
        description="Find fringe, frame bleed, pivot jumps and palette noise — drawn straight onto the sheet."
        icon={Stethoscope}
        category="extract"
        docs="lint"
      />

      <SourceBanner onReplace={() => fileInputRef.current?.click()} />

      {report && <SummaryBar report={report} disabledCount={disabled.size} />}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
        {/* ---------------- Left: source, rules, export ---------------- */}
        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Source</CardTitle>
              <CardDescription className="text-xs">
                Grid is auto-detected. Override it when detection gets it wrong.
              </CardDescription>
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
                  <img
                    src={sourceUrl}
                    alt="source sheet"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <div className="text-center">
                    <Upload className="w-8 h-8 text-muted-foreground mb-2 mx-auto" />
                    <p className="text-sm text-muted-foreground">Upload / drop / paste a sheet</p>
                  </div>
                )}
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                  }}
                />
              </div>
              <SampleSprites />

              {report && (
                <>
                  <div className="flex items-center justify-between p-2.5 rounded-lg border bg-muted/10">
                    <div className="space-y-0.5">
                      <Label className="text-xs font-medium">Override grid</Label>
                      <p className="text-[10px] text-muted-foreground leading-tight">
                        {report.grid.detected
                          ? `Detected ${report.grid.cols}×${report.grid.rows} (${Math.round(
                              (report.grid.confidence ?? 0) * 100,
                            )}% confident)`
                          : `Using your ${report.grid.cols}×${report.grid.rows}`}
                      </p>
                    </div>
                    <Switch checked={gridOverride} onCheckedChange={setGridOverride} />
                  </div>
                  {gridOverride && (
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
                  )}
                  {!gridOverride && report.grid.detected && (
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Wand2 className="w-3 h-3" />
                      {report.frameWidth}×{report.frameHeight} px cells ·{" "}
                      {report.summary.frameCount} frames
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {report && (
            <Card>
              <CardHeader className="pb-3 flex flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">Rules</CardTitle>
                  <CardDescription className="text-xs">
                    Turn a rule off to re-lint without it.
                  </CardDescription>
                </div>
                {disabled.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setDisabled(new Set<RuleId>())}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" /> Reset
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-1.5">
                {RULE_IDS.map((id) => {
                  const on = !disabled.has(id);
                  const count = findingCountByRule.get(id) ?? 0;
                  const skipped = skipReasonByRule.get(id);
                  return (
                    <div
                      key={id}
                      className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "text-xs font-medium truncate",
                              !on && "text-muted-foreground line-through",
                            )}
                            title={RULE_DOCS[id].summary}
                          >
                            {RULE_DOCS[id].title}
                          </span>
                          {on && count > 0 && (
                            <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground">
                              {count}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                          {!on ? "disabled" : (skipped ?? id)}
                        </p>
                      </div>
                      <Switch checked={on} onCheckedChange={() => toggleRule(id)} />
                    </div>
                  );
                })}
                <div className="pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void copyCli()}
                  >
                    <Terminal className="w-3.5 h-3.5 mr-2" /> Copy CLI command
                  </Button>
                  <pre className="mt-2 text-[10px] font-mono bg-muted/40 border rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {cliCommand}
                  </pre>
                </div>
              </CardContent>
            </Card>
          )}

          {report && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Report
                </CardTitle>
                <CardDescription className="text-xs">
                  The same JSON `sprite-tools lint` writes.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button onClick={downloadJson} className="w-full">
                  <Download className="w-4 h-4 mr-2" /> Download JSON
                </Button>
                <Button onClick={() => void copyJson()} variant="outline" className="w-full">
                  <Copy className="w-4 h-4 mr-2" /> Copy to Clipboard
                </Button>
                <JsonPreview data={report} className="mt-2" />
              </CardContent>
            </Card>
          )}
        </div>

        {/* ---------------- Middle: the overlay ---------------- */}
        <div className="lg:col-span-6">
          <Card className="shadow-lg ring-1 ring-primary/10">
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Sheet</CardTitle>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  title="Toggle background grid"
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
                onZoomIn={() => sheet && viewport.setZoomIn(sheet.width, sheet.height)}
                onZoomOut={() => sheet && viewport.setZoomOut(sheet.width, sheet.height)}
                onReset={() => sheet && viewport.fitToView(sheet.width, sheet.height)}
              />
            </CardHeader>
            <CardContent>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: pan surface, not a control */}
              <div
                ref={previewContainerRef}
                className={cn(
                  "aspect-square lg:aspect-auto lg:h-[36rem] rounded-lg border overflow-hidden relative cursor-move touch-none",
                  gridTheme === "light" ? "checkerboard-light" : "checkerboard-dark",
                )}
                onMouseDown={viewport.startPanning}
                onMouseMove={viewport.updatePanning}
                onMouseUp={viewport.stopPanning}
                onMouseLeave={() => {
                  viewport.stopPanning();
                  setHovered(null);
                }}
              >
                {sheet && sourceUrl && report ? (
                  <>
                    <div
                      className="absolute top-0 left-0"
                      style={{
                        width: sheet.width,
                        height: sheet.height,
                        transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <img
                        src={sourceUrl}
                        alt="Sheet being linted"
                        width={sheet.width}
                        height={sheet.height}
                        className="block select-none"
                        draggable={false}
                        style={{ imageRendering: "pixelated" }}
                      />
                      <FindingOverlay
                        report={report}
                        activeIndex={active}
                        selectedIndex={selected}
                        strokeWidth={strokeWidth}
                        onSelect={selectFinding}
                        onHover={setHovered}
                      />
                    </div>
                    <ZoomIndicator
                      zoom={view.zoom}
                      baseZoom={baseView.zoom}
                      className="absolute bottom-2 right-2"
                    />
                    <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-mono pointer-events-none">
                      {report.width}×{report.height} · {report.grid.cols}×{report.grid.rows} grid ·{" "}
                      {report.summary.frameCount} frames
                    </div>
                    {active !== null && findings[active] && (
                      <div className="absolute bottom-2 left-2 right-16 bg-black/70 text-white text-[11px] px-2.5 py-1.5 rounded pointer-events-none">
                        <span className="font-mono opacity-70">{findings[active].rule}</span>{" "}
                        {findings[active].message}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                    <Sparkles className="w-10 h-10 opacity-30 mb-2" />
                    <p className="text-sm">
                      {isLoading ? "Reading image…" : "Upload a sheet to lint it"}
                    </p>
                  </div>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Drag to pan, scroll to zoom. Boxes are sheet-absolute regions straight from the
                report — click one to jump to its finding.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ---------------- Right: findings ---------------- */}
        <div className="lg:col-span-3">
          <Card className="lg:sticky lg:top-20">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Findings</CardTitle>
              <CardDescription className="text-xs">
                {findings.length === 0
                  ? "Nothing to report."
                  : "Hover to highlight, click a rule id to mute it."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!report ? (
                <p className="text-xs text-muted-foreground py-6 text-center">
                  Load a sheet to see findings.
                </p>
              ) : findings.length === 0 ? (
                <CleanState report={report} />
              ) : (
                <ul className="space-y-1.5 max-h-[36rem] overflow-y-auto pr-1 -mr-1">
                  {findings.map((f, i) => (
                    <FindingRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: index is the finding's identity in the report ordering
                      key={`${f.rule}-${f.frame}-${i}`}
                      finding={f}
                      index={i}
                      isActive={active === i}
                      isSelected={selected === i}
                      registerRef={(el) => {
                        if (el) rowRefs.current.set(i, el);
                        else rowRefs.current.delete(i);
                      }}
                      onSelect={() => setSelected((s) => (s === i ? null : i))}
                      onHover={setHovered}
                      onMuteRule={() => toggleRule(f.rule)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {(loadError || result.error) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground px-4 py-2 rounded shadow-lg text-sm">
          {loadError ?? result.error}
        </div>
      )}
    </main>
  );
}

// -----------------------------------------------------------------
// Summary bar
// -----------------------------------------------------------------

function SummaryBar({ report, disabledCount }: { report: LintReport; disabledCount: number }) {
  const { errors, warnings, infos } = report.summary;
  const clean = errors === 0 && warnings === 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-3 mt-4",
        clean ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-muted/20",
      )}
    >
      {clean ? (
        <span className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="w-4 h-4" />
          Clean — no errors or warnings
        </span>
      ) : (
        <span className="flex items-center gap-2 text-sm font-medium">
          <Stethoscope className="w-4 h-4 text-muted-foreground" />
          {errors + warnings} thing{errors + warnings === 1 ? "" : "s"} worth a look
        </span>
      )}
      <Count severity="error" n={errors} />
      <Count severity="warning" n={warnings} />
      <Count severity="info" n={infos} />
      <span className="text-xs text-muted-foreground font-mono ml-auto">
        {report.summary.rulesRun.length}/{RULE_IDS.length} rules ran
        {disabledCount > 0 && ` · ${disabledCount} muted`}
        {report.summary.rulesSkipped.length > 0 &&
          ` · ${report.summary.rulesSkipped.length} skipped`}
      </span>
    </div>
  );
}

function Count({ severity, n }: { severity: Severity; n: number }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-mono",
        n === 0 && "text-muted-foreground/50",
      )}
    >
      <s.Icon
        className="w-3.5 h-3.5"
        style={n === 0 ? undefined : { color: s.stroke }}
        aria-hidden="true"
      />
      {n} {s.label}
      {n === 1 ? "" : "s"}
    </span>
  );
}

function CleanState({ report }: { report: LintReport }) {
  return (
    <div className="text-center py-8 space-y-3">
      <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto">
        <CheckCircle2 className="w-6 h-6 text-emerald-500" />
      </div>
      <div>
        <p className="text-sm font-medium">Sheet passed</p>
        <p className="text-xs text-muted-foreground mt-1">
          {report.summary.rulesRun.length} rule{report.summary.rulesRun.length === 1 ? "" : "s"} ran
          over {report.summary.frameCount} frame
          {report.summary.frameCount === 1 ? "" : "s"} and found nothing.
        </p>
      </div>
      {report.summary.rulesSkipped.length > 0 && (
        <details className="text-left">
          <summary className="text-[10px] uppercase tracking-wider text-muted-foreground cursor-pointer">
            {report.summary.rulesSkipped.length} rule
            {report.summary.rulesSkipped.length === 1 ? "" : "s"} skipped
          </summary>
          <ul className="mt-2 space-y-1">
            {report.summary.rulesSkipped.map((s) => (
              <li key={s.rule} className="text-[10px] text-muted-foreground leading-snug">
                <span className="font-mono text-foreground/70">{s.rule}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// -----------------------------------------------------------------
// Findings list row
// -----------------------------------------------------------------

function FindingRow({
  finding,
  index,
  isActive,
  isSelected,
  registerRef,
  onSelect,
  onHover,
  onMuteRule,
}: {
  finding: Finding;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  registerRef: (el: HTMLLIElement | null) => void;
  onSelect: () => void;
  onHover: (i: number | null) => void;
  onMuteRule: () => void;
}) {
  const s = SEVERITY_STYLE[finding.severity];
  const locatable = finding.region !== null || finding.at !== null;

  return (
    <li
      ref={registerRef}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "rounded-md border transition-colors",
        isSelected ? "border-primary/60 bg-primary/5" : "border-border/60",
        isActive && !isSelected && "bg-accent/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left px-2.5 pt-2 pb-1.5 cursor-pointer"
        title={locatable ? "Highlight on the sheet" : "Sheet-wide finding"}
      >
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-px rounded border text-[9px] font-medium uppercase tracking-wide",
              s.chip,
            )}
          >
            <s.Icon className="w-2.5 h-2.5" />
            {s.label}
          </span>
          <span className="text-[10px] font-mono text-muted-foreground ml-auto">
            {finding.frame === null
              ? "sheet"
              : `frame ${finding.frame}${
                  finding.cell ? ` · r${finding.cell.row}c${finding.cell.col}` : ""
                }`}
          </span>
        </div>
        <p className="text-[11px] leading-snug">{finding.message}</p>
      </button>
      <div className="px-2.5 pb-1.5">
        <button
          type="button"
          onClick={onMuteRule}
          className="text-[10px] font-mono text-muted-foreground hover:text-destructive transition-colors underline decoration-dotted underline-offset-2"
          title={`Turn off ${finding.rule} and re-lint`}
        >
          {finding.rule}
        </button>
      </div>
    </li>
  );
}

// -----------------------------------------------------------------
// The overlay itself
// -----------------------------------------------------------------

function FindingOverlay({
  report,
  activeIndex,
  selectedIndex,
  strokeWidth,
  onSelect,
  onHover,
}: {
  report: LintReport;
  activeIndex: number | null;
  selectedIndex: number | null;
  strokeWidth: number;
  onSelect: (i: number) => void;
  onHover: (i: number | null) => void;
}) {
  const { width, height, frameWidth, frameHeight, grid, findings } = report;
  // Index-based, so a hover left over from a previous lint run can point past
  // the end of the current list — resolve it before trusting it.
  const activeFinding = activeIndex === null ? null : (findings[activeIndex] ?? null);
  const hasActive = activeFinding !== null;
  // A sheet-wide finding has nowhere to point, so selecting one outlines the
  // whole sheet rather than silently doing nothing.
  const activeIsSheetWide = hasActive && !activeFinding.region && !activeFinding.at;

  const markerSize = Math.max(3, Math.min(frameWidth, frameHeight) / 6);
  const sheetInset = Math.min(strokeWidth, Math.min(width, height) / 4);

  return (
    <svg
      className="absolute top-0 left-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible" }}
      role="img"
      aria-label={`${findings.length} lint findings drawn over the sheet`}
    >
      <title>Lint findings overlay</title>

      {/* Cell outlines on the real cut lines (margin and gutters included), faint, underneath everything. */}
      <g stroke="currentColor" strokeWidth={strokeWidth * 0.5} opacity={0.28} fill="none">
        {Array.from({ length: grid.cols * grid.rows }, (_, i) => {
          const col = i % grid.cols;
          const row = Math.floor(i / grid.cols);
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: positional cell outline, never reordered
              key={i}
              x={grid.margin.left + col * (frameWidth + grid.spacing.x)}
              y={grid.margin.top + row * (frameHeight + grid.spacing.y)}
              width={frameWidth}
              height={frameHeight}
            />
          );
        })}
      </g>

      {activeIsSheetWide && (
        <rect
          // strokeWidth grows as the zoom shrinks, so the inset has to be
          // clamped: past it the width goes negative, which is an SVG error and
          // silently renders nothing at all.
          x={sheetInset}
          y={sheetInset}
          width={width - sheetInset * 2}
          height={height - sheetInset * 2}
          fill="none"
          stroke={SEVERITY_STYLE[activeFinding.severity].stroke}
          strokeWidth={strokeWidth * 1.5}
          strokeDasharray={`${strokeWidth * 4} ${strokeWidth * 3}`}
        />
      )}

      {findings.map((f, i) => {
        const style = SEVERITY_STYLE[f.severity];
        const isActive = i === activeIndex;
        const isSelected = i === selectedIndex;
        // Dim the rest once something is picked, so the highlighted region
        // reads at a glance even on a sheet with a dozen findings.
        const opacity = hasActive && !isActive ? 0.22 : 1;
        const region = f.region;
        const at = f.at;
        if (!region && !at) return null;

        return (
          // biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent; role + tabIndex + key handler is the substitute
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: the report's own ordering is the finding's identity
            key={`f${i}-${f.rule}`}
            role="button"
            tabIndex={0}
            aria-label={`${f.severity}: ${f.message}`}
            opacity={opacity}
            style={{ cursor: "pointer", pointerEvents: "auto" }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(i);
              }
            }}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
          >
            {region ? (
              <rect
                x={region.x}
                y={region.y}
                width={region.width}
                height={region.height}
                fill={isActive ? style.fill : "transparent"}
                stroke={style.stroke}
                strokeWidth={strokeWidth * (isActive || isSelected ? 2 : 1)}
                strokeDasharray={isSelected ? `${strokeWidth * 3} ${strokeWidth * 2}` : undefined}
              />
            ) : null}
            {at ? (
              <g stroke={style.stroke} strokeWidth={strokeWidth * (isActive ? 2 : 1)} fill="none">
                <circle cx={at.x + 0.5} cy={at.y + 0.5} r={markerSize} />
                <line
                  x1={at.x + 0.5 - markerSize * 1.6}
                  y1={at.y + 0.5}
                  x2={at.x + 0.5 - markerSize * 0.4}
                  y2={at.y + 0.5}
                />
                <line
                  x1={at.x + 0.5 + markerSize * 0.4}
                  y1={at.y + 0.5}
                  x2={at.x + 0.5 + markerSize * 1.6}
                  y2={at.y + 0.5}
                />
                <line
                  x1={at.x + 0.5}
                  y1={at.y + 0.5 - markerSize * 1.6}
                  x2={at.x + 0.5}
                  y2={at.y + 0.5 - markerSize * 0.4}
                />
                <line
                  x1={at.x + 0.5}
                  y1={at.y + 0.5 + markerSize * 0.4}
                  x2={at.x + 0.5}
                  y2={at.y + 0.5 + markerSize * 1.6}
                />
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
