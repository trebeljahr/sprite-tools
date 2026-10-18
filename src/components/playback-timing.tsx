"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** Preview speed scales all holds together; it never resamples or changes exports. */
export function PlaybackTiming({
  durationMs,
  speed,
  onSpeedChange,
}: {
  durationMs: number;
  speed: number;
  onSpeedChange: (speed: number) => void;
}) {
  const id = useId();
  const change = (value: number) => {
    if (Number.isFinite(value) && value > 0) onSpeedChange(Math.min(4, Math.max(0.25, value)));
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-32 flex-1 space-y-1">
          <Label htmlFor={`${id}-speed`} className="text-xs">
            Preview speed · {speed.toFixed(2)}×
          </Label>
          <input
            id={`${id}-speed`}
            type="range"
            min={0.25}
            max={4}
            step={0.05}
            value={speed}
            onChange={(event) => change(Number(event.target.value))}
            className="w-full accent-primary"
          />
        </div>
        <div className="w-28 space-y-1">
          <Label htmlFor={`${id}-duration`} className="text-xs">
            Loop seconds
          </Label>
          <Input
            id={`${id}-duration`}
            type="number"
            min={durationMs / 4000}
            max={durationMs / 250}
            step={0.05}
            disabled={durationMs <= 0}
            value={Number((durationMs / speed / 1000).toFixed(3))}
            onChange={(event) => {
              const seconds = Number(event.target.value);
              if (seconds > 0) change(durationMs / (seconds * 1000));
            }}
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => onSpeedChange(1)}>
          Reset 1×
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Preview only. Frame selection and exported timing stay unchanged.
      </p>
    </div>
  );
}
