"use client";

import * as React from "react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ChevronDown } from "lucide-react";
import { cn, type ChromaKeySettings } from "@/lib/utils";

export interface BackgroundRemovalState extends ChromaKeySettings {
  removeBackground: boolean;
  autoCrop: boolean;
}

interface BackgroundRemovalSettingsProps {
  state: BackgroundRemovalState;
  setState: (
    state:
      | BackgroundRemovalState
      | ((prev: BackgroundRemovalState) => BackgroundRemovalState),
  ) => void;
  showAdvanced?: boolean;
  setShowAdvanced?: (show: boolean) => void;
  compact?: boolean;
}

export function BackgroundRemovalSettings({
  state,
  setState,
  showAdvanced: controlledShowAdvanced,
  setShowAdvanced: controlledSetShowAdvanced,
  compact = false,
}: BackgroundRemovalSettingsProps) {
  const [localShowAdvanced, setLocalShowAdvanced] = React.useState(false);
  const showAdvanced = controlledShowAdvanced ?? localShowAdvanced;
  const setShowAdvanced = controlledSetShowAdvanced ?? setLocalShowAdvanced;

  const updateField = (field: keyof BackgroundRemovalState, value: unknown) => {
    setState((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className={cn(compact ? "text-xs" : "text-sm font-medium")}>
            Background Removal
          </Label>
          {!compact && (
            <p className="text-xs text-muted-foreground">
              For true transparency.
            </p>
          )}
        </div>
        <Switch
          checked={state.removeBackground}
          onCheckedChange={(v) => updateField("removeBackground", v)}
          className={cn(compact && "scale-75 origin-right")}
        />
      </div>

      {state.removeBackground && (
        <div className="pt-1">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group"
          >
            <ChevronDown
              className={cn(
                "w-3 h-3 transition-transform duration-200",
                showAdvanced && "rotate-180",
              )}
            />
            Advanced Settings
          </button>
        </div>
      )}

      {state.removeBackground && showAdvanced && (
        <div
          className={cn(
            "space-y-4 pt-2 animate-in slide-in-from-top-2 duration-300",
            compact && "grid grid-cols-2 gap-x-6 gap-y-4 space-y-0",
          )}
        >
          <div className="flex items-center justify-between col-span-2 pb-2 border-b border-dashed mb-2">
            <div className="space-y-0.5">
              <Label
                className={cn(compact ? "text-xs" : "text-sm font-medium")}
              >
                Auto-Crop Content
              </Label>
              {!compact && (
                <p className="text-xs text-muted-foreground/70">
                  Tight uniform bounds based on transparency
                </p>
              )}
            </div>
            <Switch
              checked={state.autoCrop}
              onCheckedChange={(v) => updateField("autoCrop", v)}
              className={cn(compact && "scale-75 origin-right")}
            />
          </div>
          {[
            {
              label: "Similarity",
              val: state.similarity,
              field: "similarity" as const,
              max: 150,
            },
            {
              label: "Edge Softness",
              val: state.softness,
              field: "softness" as const,
              max: 50,
            },
            {
              label: "Color Spill",
              val: state.spill,
              field: "spill" as const,
              max: 100,
            },
            {
              label: "Mask Choke",
              val: state.choke,
              field: "choke" as const,
              max: 5,
            },
          ].map((s) => (
            <div key={s.label} className="space-y-2">
              <div className="flex justify-between">
                <Label className="text-xs text-muted-foreground">
                  {s.label}
                </Label>
                <span className="text-xs font-mono">{s.val}</span>
              </div>
              <Slider
                value={[s.val]}
                min={0}
                max={s.max}
                step={1}
                onValueChange={(v) => updateField(s.field, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
