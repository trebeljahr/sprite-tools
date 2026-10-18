"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";

const metadataSchema = z
  .object({
    frameCount: z.number().int().min(1).max(120),
    frameWidth: z.number().int().min(1).max(1024),
    frameHeight: z.number().int().min(1).max(1024),
    grid: z.object({
      cols: z.number().int().min(1).max(32),
      rows: z.number().int().min(1).max(120),
    }),
    frameDurations: z.array(z.number().positive().max(30_000)).min(1).max(120),
    sourceFrameIndices: z.array(z.number().int().min(0)).optional(),
    selection: z
      .object({
        startSeconds: z.number(),
        endSeconds: z.number(),
        durationSeconds: z.number(),
        inputFrameCount: z.number(),
        outputFrameCount: z.number(),
        loopMode: z.enum(["full", "auto"]),
        seamScore: z.number().optional(),
        loopFound: z.boolean().optional(),
        note: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.frameDurations.length === value.frameCount &&
      value.frameCount <= value.grid.cols * value.grid.rows,
  );

export type VideoLoopMetadata = z.infer<typeof metadataSchema>;
export function parseVideoLoopMetadata(value: unknown): VideoLoopMetadata {
  const parsed = metadataSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Could not read the frame timing in this output. Reprocess the saved video.");
  return parsed.data;
}

export function VideoLoopPreview({
  sheetUrl,
  metadata,
}: {
  sheetUrl: string;
  metadata: VideoLoopMetadata;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [sheet, setSheet] = useState<HTMLImageElement | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const indexRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState("");
  const durationMs = metadata.frameDurations.reduce((sum, duration) => sum + duration, 0);

  useEffect(() => {
    let active = true;
    const image = new Image();
    setSheet(null);
    setError("");
    setFrameIndex(0);
    indexRef.current = 0;
    image.onload = () => {
      if (active) setSheet(image);
    };
    image.onerror = () => {
      if (active) setError("Could not load the sprite preview.");
    };
    image.src = sheetUrl;
    return () => {
      active = false;
    };
  }, [sheetUrl]);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !sheet) return;
    ctx.clearRect(0, 0, metadata.frameWidth, metadata.frameHeight);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sheet,
      (frameIndex % metadata.grid.cols) * metadata.frameWidth,
      Math.floor(frameIndex / metadata.grid.cols) * metadata.frameHeight,
      metadata.frameWidth,
      metadata.frameHeight,
      0,
      0,
      metadata.frameWidth,
      metadata.frameHeight,
    );
  }, [frameIndex, metadata, sheet]);

  useEffect(() => {
    if (!playing || !sheet) return;
    const started = performance.now();
    const offset = metadata.frameDurations
      .slice(0, indexRef.current)
      .reduce((sum, duration) => sum + duration, 0);
    let animation: number;
    const tick = (now: number) => {
      const position = (now - started + offset) % durationMs;
      let index = 0,
        end = metadata.frameDurations[0];
      while (position >= end && index < metadata.frameCount - 1)
        end += metadata.frameDurations[++index];
      if (index !== indexRef.current) {
        indexRef.current = index;
        setFrameIndex(index);
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, sheet, metadata, durationMs]);

  const seek = (index: number) => {
    setPlaying(false);
    const next = (index + metadata.frameCount) % metadata.frameCount;
    indexRef.current = next;
    setFrameIndex(next);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Sprite loop preview</h2>
        <p className="text-xs text-muted-foreground">
          {metadata.frameCount} frames · {(durationMs / 1000).toFixed(2)} s
        </p>
      </div>
      <div className="flex min-h-48 items-center justify-center rounded-md border bg-[repeating-conic-gradient(#8882_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
        <canvas
          ref={canvas}
          width={metadata.frameWidth}
          height={metadata.frameHeight}
          aria-label={`Animation preview, frame ${frameIndex + 1} of ${metadata.frameCount}`}
          className="max-h-72 max-w-full [image-rendering:pixelated]"
          style={{ width: Math.min(480, metadata.frameWidth * 2), height: "auto" }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => seek(frameIndex - 1)}
          aria-label="Previous sprite frame"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPlaying((value) => !value)}
          aria-label={playing ? "Pause sprite loop" : "Play sprite loop"}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => seek(frameIndex + 1)}
          aria-label="Next sprite frame"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <input
          type="range"
          min={0}
          max={metadata.frameCount - 1}
          value={frameIndex}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="Sprite frame"
          className="min-w-0 flex-1 accent-primary"
        />
        <span className="min-w-14 text-right text-xs tabular-nums">
          {frameIndex + 1}/{metadata.frameCount}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Frame hold: {metadata.frameDurations[frameIndex]} ms
        {metadata.sourceFrameIndices?.[frameIndex] !== undefined
          ? ` · source frame ${metadata.sourceFrameIndices[frameIndex]}`
          : ""}{" "}
        · actual exported timing
      </p>
      {metadata.selection && (
        <p className="text-xs text-muted-foreground">
          Selected {metadata.selection.startSeconds.toFixed(2)}–
          {metadata.selection.endSeconds.toFixed(2)} s · {metadata.selection.inputFrameCount}{" "}
          sampled → {metadata.selection.outputFrameCount} output frames
          {metadata.selection.seamScore !== undefined
            ? ` · seam score ${metadata.selection.seamScore.toFixed(4)} (lower is closer)`
            : ""}
        </p>
      )}
      {metadata.selection?.loopMode === "auto" && (
        <p className="text-xs text-muted-foreground">
          {metadata.selection.loopFound === false
            ? "No reliable loop found; showing the full trimmed range."
            : "Suggested loop. Check the last-to-first transition and motion before exporting."}{" "}
          {metadata.selection.note}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
