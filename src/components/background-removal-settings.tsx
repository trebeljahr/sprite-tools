"use client";

import type * as React from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn, type ChromaKeySettings } from "@/lib/utils";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BackgroundMode } from "@/lib/utils";

export type AspectRatio = "free" | "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export interface BackgroundRemovalState extends ChromaKeySettings {
  backgroundMode: BackgroundMode;
  autoCrop: boolean;
  aspectRatio: AspectRatio;
}

interface BackgroundRemovalSettingsProps {
  state: BackgroundRemovalState;
  setState: (
    state: BackgroundRemovalState | ((prev: BackgroundRemovalState) => BackgroundRemovalState),
  ) => void;
  compact?: boolean;
  mode?: "full" | "chroma-only";
  renderFooter?: () => React.ReactNode;
}

export function BackgroundRemovalSettings({
  state,
  setState,
  compact = false,
  mode = "full",
  renderFooter,
}: BackgroundRemovalSettingsProps) {
  const updateField = (field: keyof BackgroundRemovalState, value: unknown) => {
    setState((prev) => ({ ...prev, [field]: value }));
  };

  if (mode === "chroma-only") {
    const isEnabled = state.backgroundMode === "chroma-transparent";

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/5">
          <div className="space-y-0.5">
            <Label className="text-sm font-bold">Auto Background Removal</Label>
            <p className="text-[10px] text-muted-foreground leading-tight">
              Remove color-based background using Chroma Key.
            </p>
          </div>
          <Switch
            checked={isEnabled}
            onCheckedChange={(v) =>
              updateField("backgroundMode", v ? "chroma-transparent" : "transparent-cutout")
            }
          />
        </div>

        {isEnabled && (
          <div className="space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="flex items-center justify-between px-1">
              <Label className="text-xs font-medium">Auto-Crop Content</Label>
              <Switch
                checked={state.autoCrop}
                onCheckedChange={(v) => updateField("autoCrop", v)}
                className="scale-75 origin-right"
              />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3 bg-muted/20 p-3 rounded-lg border border-dashed">
              {[
                {
                  label: "Similarity",
                  val: state.similarity,
                  field: "similarity" as const,
                  max: 150,
                },
                { label: "Softness", val: state.softness, field: "softness" as const, max: 50 },
                { label: "Color Spill", val: state.spill, field: "spill" as const, max: 100 },
                { label: "Mask Choke", val: state.choke, field: "choke" as const, max: 5 },
              ].map((s) => (
                <div key={s.label} className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                      {s.label}
                    </Label>
                    <span className="text-[10px] font-mono">{s.val}</span>
                  </div>
                  <Slider
                    value={[s.val]}
                    min={0}
                    max={s.max}
                    step={1}
                    onValueChange={(v) => updateField(s.field, Array.isArray(v) ? v[0] : v)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {renderFooter && (
          <div className="pt-4 border-t border-dashed flex justify-end">{renderFooter()}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label
          className={cn(
            compact
              ? "text-[10px]"
              : "text-xs font-medium uppercase tracking-wider text-muted-foreground/70",
          )}
        >
          Background Mode
        </Label>
        <div className="grid grid-cols-1 gap-3">
          {/* Chroma Mode */}
          <div
            className={cn(
              "flex flex-col rounded-lg border-2 transition-all overflow-hidden",
              state.backgroundMode === "chroma-transparent"
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border hover:border-muted-foreground/20",
            )}
          >
            <button
              onClick={() => updateField("backgroundMode", "chroma-transparent")}
              className="flex flex-col items-start p-3 text-left w-full"
            >
              <div className="flex items-center justify-between w-full">
                <span className="text-sm font-bold">Auto Background Removal (Chroma)</span>
                {state.backgroundMode === "chroma-transparent" && (
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed opacity-80">
                Identify and remove backgrounds using color-based detection.
              </p>
            </button>

            {state.backgroundMode === "chroma-transparent" && (
              <div className="p-3 pt-0 space-y-4 border-t border-primary/10 bg-primary/5 animate-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between pt-3">
                  <Label className="text-xs font-medium">Auto-Crop Content</Label>
                  <Switch
                    checked={state.autoCrop}
                    onCheckedChange={(v) => updateField("autoCrop", v)}
                    className="scale-75 origin-right"
                  />
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  {[
                    {
                      label: "Similarity",
                      val: state.similarity,
                      field: "similarity" as const,
                      max: 150,
                    },
                    { label: "Softness", val: state.softness, field: "softness" as const, max: 50 },
                    { label: "Color Spill", val: state.spill, field: "spill" as const, max: 100 },
                    { label: "Mask Choke", val: state.choke, field: "choke" as const, max: 5 },
                  ].map((s) => (
                    <div key={s.label} className="space-y-1.5">
                      <div className="flex justify-between">
                        <Label className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                          {s.label}
                        </Label>
                        <span className="text-[10px] font-mono">{s.val}</span>
                      </div>
                      <Slider
                        value={[s.val]}
                        min={0}
                        max={s.max}
                        step={1}
                        onValueChange={(v) => updateField(s.field, Array.isArray(v) ? v[0] : v)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Solid Fill Mode */}
          <div
            className={cn(
              "flex flex-col rounded-lg border-2 transition-all overflow-hidden",
              state.backgroundMode === "chroma-solid"
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border hover:border-muted-foreground/20",
            )}
          >
            <button
              onClick={() => updateField("backgroundMode", "chroma-solid")}
              className="flex flex-col items-start p-3 text-left w-full"
            >
              <div className="flex items-center justify-between w-full">
                <span className="text-sm font-bold">Auto Background Solid Color Fill</span>
                {state.backgroundMode === "chroma-solid" && (
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed opacity-80">
                Replace background with a solid color, perfectly feathered at the edges.
              </p>
            </button>

            {state.backgroundMode === "chroma-solid" && (
              <div className="p-3 pt-0 space-y-4 border-t border-primary/10 bg-primary/5 animate-in slide-in-from-top-2 duration-200">
                <div className="space-y-3 pt-3">
                  <div className="space-y-1.5">
                    <div className="flex justify-between">
                      <Label className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                        Edge Softness (Feather)
                      </Label>
                      <span className="text-[10px] font-mono">{state.softness}px</span>
                    </div>
                    <Slider
                      value={[state.softness]}
                      min={0}
                      max={50}
                      step={1}
                      onValueChange={(v) => updateField("softness", Array.isArray(v) ? v[0] : v)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Cutout Mode */}
          <div
            className={cn(
              "flex flex-col rounded-lg border-2 transition-all overflow-hidden",
              state.backgroundMode === "transparent-cutout"
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border hover:border-muted-foreground/20",
            )}
          >
            <button
              onClick={() => updateField("backgroundMode", "transparent-cutout")}
              className="flex flex-col items-start p-3 text-left w-full"
            >
              <div className="flex items-center justify-between w-full">
                <span className="text-sm font-bold">Transparent Background (Cutout)</span>
                {state.backgroundMode === "transparent-cutout" && (
                  <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed opacity-80">
                Pasting the exact cutout shape onto a clean transparent background.
              </p>
            </button>
          </div>
        </div>
      </div>

      <div className="pt-8 border-t border-dashed flex justify-end">
        <div className="flex items-end gap-0.5">
          <div className="space-y-1 flex-1 min-w-[110px]">
            <Label
              className={cn(
                "px-1",
                compact
                  ? "text-[8px]"
                  : "text-[9px] font-bold uppercase tracking-wider text-muted-foreground/80",
              )}
            >
              Aspect Ratio
            </Label>
            <Select
              value={state.aspectRatio || "free"}
              onValueChange={(v) => updateField("aspectRatio", v as AspectRatio)}
            >
              <SelectTrigger
                className={cn(
                  "bg-background shadow-none border-border/50",
                  compact ? "h-8 text-[10px]" : "h-9 text-xs",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="1:1">1:1</SelectItem>
                <SelectItem value="16:9">16:9</SelectItem>
                <SelectItem value="9:16">9:16</SelectItem>
                <SelectItem value="4:3">4:3</SelectItem>
                <SelectItem value="3:4">3:4</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {renderFooter && <div className="flex-shrink-0">{renderFooter()}</div>}
        </div>
      </div>
    </div>
  );
}
