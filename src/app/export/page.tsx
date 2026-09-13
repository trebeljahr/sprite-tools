"use client";

// Engine export: the browser front-end for `sprite-tools export`.
//
// Everything here is a pure JSON -> text transform over the shared contract in
// src/lib/export/. The page never touches pixels, so there is no worker and no
// progress bar — the preview regenerates synchronously on every keystroke.
//
// The one exception is "Use current sheet", which reads the shared project
// image only to derive frame geometry (grid detection + intrinsic size) into a
// starter metadata document. From there it is text like any other source.

import { useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ClipboardPaste, Download, FileCode2, Upload, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ToolHeader } from "@/components/tool-header";
import { SourceBanner } from "@/components/source-banner";
import { SampleSprites } from "@/components/sample-sprites";
import { TutorialStrip, type TutorialStep } from "@/components/tutorial-strip";
import { useTutorial } from "@/hooks/use-tutorial";
import { useSharedProjectSource } from "@/lib/project/store";
import { detectSheetGrid } from "@/lib/pipeline/import";
import { track } from "@/lib/analytics";

import {
  basename,
  normalizeExportInput,
  sheetDocumentFromDetection,
  stripExtension,
  type NormalizedDoc,
} from "@/lib/export/types";
import {
  toGodotAtlasTextureFiles,
  toGodotSpriteFrames,
  type GodotLoopMode,
  type GodotPingPongMode,
} from "@/lib/export/godot";
import { toUnityMeta, unityMetaFilename, type UnityFilterMode } from "@/lib/export/unity";
import {
  toAsepriteJson,
  type AsepriteFormat,
  type AsepriteFrameNaming,
  type AsepritePivotMode,
} from "@/lib/export/aseprite";
import {
  toPhaserAtlas,
  type PhaserFrameNaming,
  type PhaserFramesLayout,
} from "@/lib/export/phaser";

// -----------------------------------------------------------------
// Formats
// -----------------------------------------------------------------

type FormatId = "godot-spriteframes" | "godot-atlastextures" | "unity" | "aseprite" | "phaser";

interface FormatMeta {
  id: FormatId;
  engine: string;
  label: string;
  blurb: string;
  /** Shown next to the Download button so the filename is never a surprise. */
  extension: string;
}

const FORMATS: FormatMeta[] = [
  {
    id: "godot-spriteframes",
    engine: "Godot 4",
    label: "SpriteFrames (.tres)",
    blurb: "One resource with every animation, ready to drop on an AnimatedSprite2D.",
    extension: ".tres",
  },
  {
    id: "godot-atlastextures",
    engine: "Godot 4",
    label: "AtlasTexture per frame (.tres)",
    blurb: "One standalone resource per frame, for projects that address frames individually.",
    extension: ".tres",
  },
  {
    id: "unity",
    engine: "Unity",
    label: "Texture importer sidecar (.meta)",
    blurb: "Multiple-sprite slicing, pivots and physics shapes for the sheet PNG.",
    extension: ".png.meta",
  },
  {
    id: "aseprite",
    engine: "Aseprite",
    label: "Sprite sheet JSON",
    blurb: "The JSON Aseprite's own sheet exporter writes — frames, frameTags, slices.",
    extension: ".json",
  },
  {
    id: "phaser",
    engine: "Phaser / PixiJS",
    label: "Texture atlas JSON",
    blurb: "TexturePacker-shaped atlas with an animations map and per-frame anchors.",
    extension: ".json",
  },
];

const MIME_TRES = "text/plain;charset=utf-8";
const MIME_META = "text/yaml;charset=utf-8";
const MIME_JSON = "application/json";

interface GeneratedFile {
  filename: string;
  content: string;
  mime: string;
}

// -----------------------------------------------------------------
// Options
// -----------------------------------------------------------------

interface Opts {
  // Normalizer
  texture: string;
  namePrefix: string;
  defaultFps: string;
  // Godot
  godotTexturePath: string;
  godotLoop: boolean;
  godotLoopMode: GodotLoopMode;
  godotPingpong: GodotPingPongMode;
  godotDefaultAlias: boolean;
  // Unity
  unityAssetPath: string;
  unityPixelsPerUnit: string;
  unityFilterMode: "0" | "1" | "2";
  unitySerializedVersion: "12" | "13";
  unityPhysicsShape: boolean;
  unityGuid: string;
  // Aseprite
  asepriteFormat: AsepriteFormat;
  asepriteFrameNames: AsepriteFrameNaming;
  asepritePivots: AsepritePivotMode;
  // Phaser
  phaserLayout: PhaserFramesLayout;
  phaserFrameNames: PhaserFrameNaming;
  phaserAnimations: boolean;
  phaserAnchors: boolean;
  phaserFrameTags: boolean;
}

const DEFAULT_OPTS: Opts = {
  texture: "",
  namePrefix: "",
  defaultFps: "",
  godotTexturePath: "",
  godotLoop: true,
  godotLoopMode: "bool",
  godotPingpong: "bake",
  godotDefaultAlias: false,
  unityAssetPath: "",
  unityPixelsPerUnit: "",
  unityFilterMode: "0",
  unitySerializedVersion: "13",
  unityPhysicsShape: true,
  unityGuid: "",
  asepriteFormat: "hash",
  asepriteFrameNames: "index",
  asepritePivots: "omit",
  phaserLayout: "hash",
  phaserFrameNames: "keep",
  phaserAnimations: true,
  phaserAnchors: true,
  phaserFrameTags: true,
};

const EXAMPLE_INPUT = `{
  "source": "hero.png",
  "frameWidth": 32,
  "frameHeight": 32,
  "grid": { "cols": 4, "rows": 3, "detected": true },
  "frameCount": 12,
  "tags": [
    { "name": "idle", "from": 0, "to": 3, "direction": "forward", "fps": 8 },
    { "name": "run", "from": 4, "to": 7, "direction": "forward", "fps": 12 },
    { "name": "hurt", "from": 8, "to": 11, "direction": "pingpong", "fps": 10 }
  ],
  "pivots": [
    { "index": 0, "cell": { "row": 0, "col": 0 }, "pivot": { "x": 16, "y": 32 } },
    { "index": 1, "cell": { "row": 0, "col": 1 }, "pivot": { "x": 16, "y": 32 } }
  ],
  "collision": [
    {
      "index": 0,
      "cell": { "row": 0, "col": 0 },
      "pointCount": 4,
      "bounds": { "x": 8, "y": 10, "width": 16, "height": 20 },
      "polygon": [[8, 10], [24, 10], [24, 30], [8, 30]]
    }
  ]
}`;

// -----------------------------------------------------------------
// Pure generation
// -----------------------------------------------------------------

/** `hero.png` -> `hero`; the stem every single-file format names itself after. */
function textureStem(doc: NormalizedDoc): string {
  const stem = stripExtension(basename(doc.texture));
  return stem.length > 0 ? stem : "spritesheet";
}

function trimmed(v: string): string | undefined {
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function positiveNumber(v: string): number | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function generate(doc: NormalizedDoc, format: FormatId, o: Opts): GeneratedFile[] {
  const stem = textureStem(doc);
  switch (format) {
    case "godot-spriteframes": {
      const content = toGodotSpriteFrames(doc, {
        texturePath: trimmed(o.godotTexturePath),
        loop: o.godotLoop,
        loopMode: o.godotLoopMode,
        pingpong: o.godotPingpong,
        defaultAlias: o.godotDefaultAlias,
      });
      return [{ filename: `${stem}.tres`, content, mime: MIME_TRES }];
    }
    case "godot-atlastextures":
      // Genuinely N files — the exporter already resolves collision-free
      // per-frame filenames, so surface them as a list rather than gluing
      // them into one .tres that Godot could not import.
      return toGodotAtlasTextureFiles(doc, {
        texturePath: trimmed(o.godotTexturePath),
      }).map((f) => ({ filename: f.filename, content: f.content, mime: MIME_TRES }));
    case "unity": {
      const content = toUnityMeta(doc, {
        assetPath: trimmed(o.unityAssetPath),
        pixelsPerUnit: positiveNumber(o.unityPixelsPerUnit),
        filterMode: Number(o.unityFilterMode) as UnityFilterMode,
        serializedVersion: o.unitySerializedVersion === "12" ? 12 : 13,
        physicsShape: o.unityPhysicsShape,
        guid: trimmed(o.unityGuid),
      });
      return [{ filename: unityMetaFilename(doc), content, mime: MIME_META }];
    }
    case "aseprite": {
      const json = toAsepriteJson(doc, {
        format: o.asepriteFormat,
        frameNames: o.asepriteFrameNames,
        pivots: o.asepritePivots,
      });
      return [
        { filename: `${stem}.json`, content: JSON.stringify(json, null, 2), mime: MIME_JSON },
      ];
    }
    case "phaser": {
      const json = toPhaserAtlas(doc, {
        layout: o.phaserLayout,
        frameNames: o.phaserFrameNames,
        animations: o.phaserAnimations,
        anchors: o.phaserAnchors,
        frameTags: o.phaserFrameTags,
      });
      return [
        { filename: `${stem}.json`, content: JSON.stringify(json, null, 2), mime: MIME_JSON },
      ];
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function downloadFile(file: GeneratedFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}

// -----------------------------------------------------------------
// Page
// -----------------------------------------------------------------

export default function ExportPage() {
  const { sourceFile, setSharedSource } = useSharedProjectSource();
  const [raw, setRaw] = useState("");
  const [inputName, setInputName] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatId>("godot-spriteframes");
  const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS);
  const [selectedFile, setSelectedFile] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [derivingSheet, setDerivingSheet] = useState(false);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const sheetInputRef = useRef<HTMLInputElement>(null);

  const patch = (next: Partial<Opts>) => setOpts((prev) => ({ ...prev, ...next }));

  // Derived, every render: parse -> normalize -> format. All three stages are
  // pure and sub-millisecond for real sheets, and each can throw on input the
  // user is still halfway through typing — so every stage reports its own
  // failure inline instead of taking the route's error boundary down.
  let doc: NormalizedDoc | null = null;
  let files: GeneratedFile[] = [];
  let parseError: string | null = null;
  let normalizeError: string | null = null;
  let formatError: string | null = null;

  const trimmedRaw = raw.trim();
  if (trimmedRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedRaw);
    } catch (err) {
      parseError = `Not valid JSON — ${messageOf(err)}`;
    }
    if (!parseError) {
      try {
        doc = normalizeExportInput(parsed, {
          texture: trimmed(opts.texture),
          namePrefix: trimmed(opts.namePrefix),
          defaultFps: positiveNumber(opts.defaultFps),
        });
      } catch (err) {
        normalizeError = messageOf(err);
      }
    }
    if (doc) {
      try {
        files = generate(doc, format, opts);
      } catch (err) {
        formatError = messageOf(err);
      }
    }
  }

  const error = parseError ?? normalizeError ?? formatError;
  const fileIndex = files.length > 0 ? Math.min(selectedFile, files.length - 1) : 0;
  const active = files[fileIndex] ?? null;
  const meta = FORMATS.find((f) => f.id === format);

  const setSource = (text: string, name: string | null) => {
    setRaw(text);
    setInputName(name);
    setSelectedFile(0);
  };

  const loadJsonFile = async (file: File) => {
    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      toast.error("Pick a .json file — the metadata a sprite-tools command wrote.");
      return;
    }
    try {
      setSource(await file.text(), file.name);
      toast.success(`Loaded ${file.name}`);
    } catch {
      toast.error("Could not read that file.");
    }
  };

  // The shared project source is an image, not metadata, so it can only supply
  // geometry: grid detection plus the sheet's intrinsic size. That is a valid
  // (if bare) metadata document — the user layers tags/pivots on by editing.
  const deriveFromSheet = async () => {
    if (!sourceFile) return;
    setDerivingSheet(true);
    try {
      const bitmap = await createImageBitmap(sourceFile);
      const { width, height } = bitmap;
      bitmap.close?.();
      const detection = await detectSheetGrid(sourceFile);
      const derived = sheetDocumentFromDetection(sourceFile.name, width, height, detection);
      setSource(JSON.stringify(derived, null, 2), sourceFile.name);
      toast.success(
        `Derived a ${derived.grid.cols}x${derived.grid.rows} grid from ${sourceFile.name}`,
      );
    } catch (err) {
      toast.error(`Could not read that sheet — ${messageOf(err)}`);
    } finally {
      setDerivingSheet(false);
    }
  };

  const download = () => {
    if (!active) return;
    downloadFile(active);
    setHasDownloaded(true);
    track("export_downloaded", { format, filename: active.filename });
    toast.success(`Downloaded ${active.filename}`);
  };

  const copyOutput = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed");
    }
  };

  const tutorialSteps: TutorialStep[] = [
    {
      label: "Load metadata",
      hint: "Paste sprite-tools JSON, drop a .json, or derive a grid from the current sheet.",
      done: trimmedRaw.length > 0,
    },
    {
      label: "Pick a format",
      hint: "Godot, Unity, Aseprite or Phaser — each with its own variants below.",
      done: files.length > 0,
    },
    {
      label: "Download",
      hint: "The file is named the way the engine expects it on disk.",
      done: hasDownloaded,
    },
  ];
  const tutorial = useTutorial({ id: "export", steps: tutorialSteps });

  return (
    <main className="container mx-auto py-8 px-4">
      <ToolHeader
        title="Export"
        description="Turn sprite-tools metadata into engine-native files — Godot, Unity, Aseprite, Phaser."
        icon={FileCode2}
        category="export"
        docs="export"
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
      {/* The banner tracks the shared *image* source, so Replace swaps the
          sheet — the metadata JSON has its own picker inside the card. */}
      <SourceBanner onReplace={() => sheetInputRef.current?.click()} />
      <input
        ref={sheetInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void setSharedSource(file);
          e.target.value = "";
        }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* ---------------- left: source + options ---------------- */}
        <div className="lg:col-span-5 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Metadata</CardTitle>
              <CardDescription className="text-xs">
                Output of <code className="font-mono">meta</code>,{" "}
                <code className="font-mono">collision</code>,{" "}
                <code className="font-mono">pivot</code>, <code className="font-mono">tags</code> or{" "}
                <code className="font-mono">atlas</code> — including a{" "}
                <code className="font-mono">jq -s add</code> merge of several.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => jsonInputRef.current?.click()}
                >
                  <Upload className="w-3.5 h-3.5 mr-1" /> Upload .json
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={!sourceFile || derivingSheet}
                  onClick={() => void deriveFromSheet()}
                  title={
                    sourceFile
                      ? "Detect the grid on the shared project sheet and start from that"
                      : "Load a sheet on any tool page first"
                  }
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" />
                  {derivingSheet ? "Reading sheet…" : "Use current sheet"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => setSource(EXAMPLE_INPUT, "example.json")}
                >
                  <ClipboardPaste className="w-3.5 h-3.5 mr-1" /> Example
                </Button>
              </div>

              {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target wraps a real <textarea>; typing and paste both work without it */}
              <div
                className={cn("rounded-lg transition-colors", isDragging && "ring-2 ring-primary")}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) void loadJsonFile(file);
                }}
              >
                <Textarea
                  value={raw}
                  onChange={(e) => setSource(e.target.value, inputName)}
                  spellCheck={false}
                  placeholder={
                    'Paste or drop sprite-tools JSON here…\n\n{ "frameWidth": 32, "frameHeight": 32, "grid": { "cols": 4, "rows": 3 } }'
                  }
                  className="font-mono text-[11px] leading-snug h-56 max-h-56 overflow-y-auto resize-none"
                />
              </div>
              <Input
                ref={jsonInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void loadJsonFile(file);
                  e.target.value = "";
                }}
              />
              {inputName && (
                <p className="text-[10px] text-muted-foreground font-mono truncate">{inputName}</p>
              )}
              <SampleSprites />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Target</CardTitle>
              <CardDescription className="text-xs">{meta?.blurb}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs">Format</Label>
                <Select
                  value={format}
                  onValueChange={(v) => {
                    setFormat(v as FormatId);
                    setSelectedFile(0);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMATS.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.engine} · {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TextOpt
                  label="Texture filename"
                  placeholder={doc?.texture ?? "hero.png"}
                  value={opts.texture}
                  onChange={(v) => patch({ texture: v })}
                />
                <TextOpt
                  label="Frame name prefix"
                  placeholder="from texture"
                  value={opts.namePrefix}
                  onChange={(v) => patch({ namePrefix: v })}
                />
                <TextOpt
                  label="Default FPS"
                  placeholder="10"
                  value={opts.defaultFps}
                  onChange={(v) => patch({ defaultFps: v })}
                />
              </div>

              {(format === "godot-spriteframes" || format === "godot-atlastextures") && (
                <div className="space-y-3 border-t pt-3">
                  <TextOpt
                    label="Texture path in project"
                    placeholder={doc ? `res://${doc.texture}` : "res://art/hero.png"}
                    value={opts.godotTexturePath}
                    onChange={(v) => patch({ godotTexturePath: v })}
                  />
                  {format === "godot-spriteframes" && (
                    <>
                      <SwitchOpt
                        label="Loop animations"
                        checked={opts.godotLoop}
                        onChange={(v) => patch({ godotLoop: v })}
                      />
                      <SelectOpt
                        label="Loop field"
                        value={opts.godotLoopMode}
                        onChange={(v) => patch({ godotLoopMode: v as GodotLoopMode })}
                        options={[
                          ["bool", "bool — every Godot 4.x"],
                          ["int", "LoopMode enum — Godot 4.7+"],
                        ]}
                      />
                      <SelectOpt
                        label="Ping-pong tags"
                        value={opts.godotPingpong}
                        onChange={(v) => patch({ godotPingpong: v as GodotPingPongMode })}
                        options={[
                          ["bake", "bake — explicit frame list"],
                          ["native", "native — LOOP_PINGPONG"],
                        ]}
                      />
                      <SwitchOpt
                        label={'Alias first animation as "default"'}
                        checked={opts.godotDefaultAlias}
                        onChange={(v) => patch({ godotDefaultAlias: v })}
                      />
                    </>
                  )}
                </div>
              )}

              {format === "unity" && (
                <div className="space-y-3 border-t pt-3">
                  <TextOpt
                    label="Asset path"
                    placeholder="Assets/Art/hero.png"
                    hint="Seeds the guid and every sprite id — pass the full project path so two same-named PNGs cannot collide."
                    value={opts.unityAssetPath}
                    onChange={(v) => patch({ unityAssetPath: v })}
                  />
                  <TextOpt
                    label="Existing guid"
                    placeholder="reuse when overwriting a .meta"
                    hint="Overwriting an in-project .meta with a fresh guid detaches every reference to the asset."
                    value={opts.unityGuid}
                    onChange={(v) => patch({ unityGuid: v })}
                  />
                  <TextOpt
                    label="Pixels per unit"
                    placeholder={doc ? String(doc.frames[0].sourceSize.h) : "32"}
                    value={opts.unityPixelsPerUnit}
                    onChange={(v) => patch({ unityPixelsPerUnit: v })}
                  />
                  <SelectOpt
                    label="Filter mode"
                    value={opts.unityFilterMode}
                    onChange={(v) => patch({ unityFilterMode: v as Opts["unityFilterMode"] })}
                    options={[
                      ["0", "Point — pixel art"],
                      ["1", "Bilinear"],
                      ["2", "Trilinear"],
                    ]}
                  />
                  <SelectOpt
                    label="Serialized version"
                    value={opts.unitySerializedVersion}
                    onChange={(v) =>
                      patch({ unitySerializedVersion: v as Opts["unitySerializedVersion"] })
                    }
                    options={[
                      ["13", "13 — Unity 6"],
                      ["12", "12 — Unity 2022.3 / 2023.x"],
                    ]}
                  />
                  <SwitchOpt
                    label="Emit collision as physicsShape"
                    checked={opts.unityPhysicsShape}
                    onChange={(v) => patch({ unityPhysicsShape: v })}
                  />
                </div>
              )}

              {format === "aseprite" && (
                <div className="space-y-3 border-t pt-3">
                  <SelectOpt
                    label="Frames layout"
                    value={opts.asepriteFormat}
                    onChange={(v) => patch({ asepriteFormat: v as AsepriteFormat })}
                    options={[
                      ["hash", "hash — keyed object"],
                      ["array", "array — with filename"],
                    ]}
                  />
                  <SelectOpt
                    label="Frame names"
                    value={opts.asepriteFrameNames}
                    onChange={(v) => patch({ asepriteFrameNames: v as AsepriteFrameNaming })}
                    options={[
                      ["index", "index — what Phaser resolves"],
                      ["aseprite", "aseprite — “hero 0.aseprite”"],
                      ["normalized", "normalized — resolved names"],
                    ]}
                  />
                  <SelectOpt
                    label="Pivots"
                    value={opts.asepritePivots}
                    onChange={(v) => patch({ asepritePivots: v as AsepritePivotMode })}
                    options={[
                      ["omit", "omit — Aseprite has no pivot key"],
                      ["slices", "slices — meta.slices pivot"],
                    ]}
                  />
                </div>
              )}

              {format === "phaser" && (
                <div className="space-y-3 border-t pt-3">
                  <SelectOpt
                    label="Frames layout"
                    value={opts.phaserLayout}
                    onChange={(v) => patch({ phaserLayout: v as PhaserFramesLayout })}
                    options={[
                      ["hash", "hash — required by PixiJS"],
                      ["array", "array — with filename"],
                    ]}
                  />
                  <SelectOpt
                    label="Frame names"
                    value={opts.phaserFrameNames}
                    onChange={(v) => patch({ phaserFrameNames: v as PhaserFrameNaming })}
                    options={[
                      ["keep", "keep — resolved names"],
                      ["index", "index — for createFromAseprite"],
                    ]}
                  />
                  <SwitchOpt
                    label="Animations map"
                    checked={opts.phaserAnimations}
                    onChange={(v) => patch({ phaserAnimations: v })}
                  />
                  <SwitchOpt
                    label="Per-frame anchors"
                    checked={opts.phaserAnchors}
                    onChange={(v) => patch({ phaserAnchors: v })}
                  />
                  <SwitchOpt
                    label="meta.frameTags"
                    checked={opts.phaserFrameTags}
                    onChange={(v) => patch({ phaserFrameTags: v })}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---------------- right: preview + download ---------------- */}
        <div className="lg:col-span-7 space-y-6">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex gap-3">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-destructive">
                  {parseError
                    ? "That is not JSON yet"
                    : normalizeError
                      ? "This document cannot be normalized"
                      : `${meta?.engine} export failed`}
                </p>
                <p className="text-xs text-muted-foreground break-words">{error}</p>
              </div>
            </div>
          )}

          {doc && !formatError && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground rounded-md border bg-muted/20 px-3 py-2">
              <span className="font-mono text-foreground">{doc.texture}</span>
              <span>
                {doc.textureWidth}×{doc.textureHeight}
              </span>
              <span>{doc.frames.length} frames</span>
              {doc.grid && (
                <span>
                  grid {doc.grid.cols}×{doc.grid.rows}
                </span>
              )}
              <span>{doc.tags.length} tags</span>
              <span>{doc.frames.filter((f) => f.pivot).length} pivots</span>
              <span>{doc.frames.filter((f) => f.polygon).length} polygons</span>
            </div>
          )}

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">
                    {active ? active.filename : `Preview${meta ? ` · ${meta.extension}` : ""}`}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {active
                      ? `${active.content.split("\n").length} lines · ${formatBytes(active.content)}`
                      : "Load metadata on the left to generate a file."}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!active}
                  onClick={() => void copyOutput()}
                >
                  Copy
                </Button>
                <Button size="sm" disabled={!active} onClick={download}>
                  <Download className="w-4 h-4 mr-1" /> Download
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {files.length > 1 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {files.length} files — one per frame. Download them one at a time.
                  </p>
                  <div className="max-h-40 overflow-y-auto rounded-md border divide-y">
                    {files.map((f, i) => (
                      <div
                        key={f.filename}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1 text-xs",
                          i === fileIndex && "bg-accent/40",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedFile(i)}
                          className="flex-1 min-w-0 text-left font-mono truncate hover:text-foreground text-muted-foreground"
                        >
                          {f.filename}
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadFile(f)}
                          className="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                          title={`Download ${f.filename}`}
                        >
                          <Download className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <pre className="rounded-md border bg-muted/20 p-3 text-[11px] leading-snug font-mono overflow-x-auto max-h-[min(65vh,40rem)] overflow-y-auto whitespace-pre">
                {active?.content ?? "// nothing to preview yet"}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

// -----------------------------------------------------------------
// Option controls
// -----------------------------------------------------------------

function TextOpt({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs font-mono"
      />
      {hint && <p className="text-[10px] text-muted-foreground leading-snug">{hint}</p>}
    </div>
  );
}

function SelectOpt({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? value)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SwitchOpt({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs font-normal">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function formatBytes(text: string): string {
  const n = new TextEncoder().encode(text).length;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
