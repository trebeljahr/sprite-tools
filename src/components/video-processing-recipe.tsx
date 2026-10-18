"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { validateProcessing, type ProcessingOptions } from "@/lib/video/schema";

export function VideoProcessingRecipe({
  value,
  onChange,
}: {
  value: ProcessingOptions;
  onChange: (value: ProcessingOptions) => void;
}) {
  const [message, setMessage] = useState("");
  const save = () => {
    try {
      const recipe = validateProcessing(value);
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(recipe, null, 2)}\n`], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "sprite-processing.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Saved current settings.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Check the processing settings.");
    }
  };
  return (
    <details className="border-t pt-3">
      <summary className="cursor-pointer text-sm">Reuse these processing settings</summary>
      <p className="my-3 text-xs text-muted-foreground">
        Save a recipe after reviewing the loop. Load it for another video, or pass its JSON as the
        processing argument to sprite_video_reprocess. Loading only updates the controls; apply when
        ready.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" variant="outline" onClick={save}>
          Save recipe JSON
        </Button>
        <label className="cursor-pointer rounded-md border px-3 py-2 text-xs">
          Load recipe JSON
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Load recipe JSON"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                if (file.size > 32_768) throw new Error("Recipe must be smaller than 32 KiB.");
                onChange(validateProcessing(JSON.parse(await file.text())));
                setMessage("Recipe loaded. Review the controls, then apply to the saved video.");
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "Could not load recipe.");
              }
            }}
          />
        </label>
      </div>
      {message && (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      )}
    </details>
  );
}
