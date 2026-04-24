"use client";

import { useEffect, useRef, useState } from "react";
import { generateOutline } from "@/lib/collision/outline";

// Landing-page demo: loads the pterodactyl sample, traces its collision
// polygon, and cycles the simplification tolerance through three values
// every ~1.8s so visitors see the actual algorithm working. Uses the real
// sprite-tools code path (generateOutline) so what you see here IS what
// the Collision tool would produce.

const TOLERANCES = [1, 4, 10];
const CYCLE_MS = 1800;
const SCALE = 3; // upscale nearest-neighbor so pixels feel chunky

export function CollisionDemo() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [tolIdx, setTolIdx] = useState(0);

  // Load sample sprite once. Using character.png (single connected blob so
  // Moore-neighbor traces the whole silhouette, not just a wing).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/samples/character.png");
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
        if (w === 0 || h === 0) {
          console.error("collision-demo: zero-dim bitmap", { w, h, size: blob.size });
          return;
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(bitmap, 0, 0);
        // Extract ImageData BEFORE closing the bitmap — closing invalidates
        // the backing store in some browsers, which can race with dev-mode
        // StrictMode double-mounts.
        const data = ctx.getImageData(0, 0, w, h);
        bitmap.close?.();
        setImageData(data);
      } catch (e) {
        console.error("collision-demo: failed to load sample", e);
      }
    })();
  }, []);

  // Cycle tolerance index.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTolIdx((i) => (i + 1) % TOLERANCES.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const tolerance = TOLERANCES[tolIdx];

  // Render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageData) return;
    const W = imageData.width * SCALE;
    const H = imageData.height * SCALE;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Sprite: draw through an offscreen canvas so we can scale with nearest.
    const off = document.createElement("canvas");
    off.width = imageData.width;
    off.height = imageData.height;
    off.getContext("2d")?.putImageData(imageData, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, W, H);

    // Compute polygon on the original ImageData, then scale coords for the
    // canvas.
    const outline = generateOutline(imageData, {
      alphaThreshold: 10,
      simplifyTolerance: tolerance,
      convexHull: false,
    });
    if (outline.polygon.length < 2) return;

    ctx.save();
    ctx.beginPath();
    const pts = outline.polygon;
    ctx.moveTo(pts[0].x * SCALE + SCALE / 2, pts[0].y * SCALE + SCALE / 2);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * SCALE + SCALE / 2, pts[i].y * SCALE + SCALE / 2);
    }
    ctx.closePath();

    ctx.fillStyle = "rgba(74, 222, 128, 0.18)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(34, 197, 94, 0.9)";
    ctx.stroke();

    // Vertex dots.
    ctx.fillStyle = "rgba(34, 197, 94, 1)";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x * SCALE + SCALE / 2, p.y * SCALE + SCALE / 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }, [imageData, tolerance]);

  const polygon = imageData
    ? generateOutline(imageData, {
        alphaThreshold: 10,
        simplifyTolerance: tolerance,
        convexHull: false,
      }).polygon
    : [];

  return (
    <div className="relative w-full max-w-md mx-auto rounded-xl border bg-muted/10 p-4 shadow-lg ring-1 ring-primary/10">
      <div className="aspect-square flex items-center justify-center checkerboard-light rounded-md overflow-hidden">
        {imageData ? (
          <canvas
            ref={canvasRef}
            className="max-w-full max-h-full"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <div className="text-xs text-muted-foreground">loading demo…</div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3 text-xs">
        <div className="flex-1">
          <div className="flex justify-between mb-1 text-muted-foreground">
            <span>simplify tolerance</span>
            <span className="font-mono">{tolerance.toFixed(1)}px</span>
          </div>
          <div className="h-1 rounded-full bg-muted relative overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-primary transition-all duration-700 ease-out"
              style={{
                width: `${(tolerance / 15) * 100}%`,
              }}
            />
          </div>
        </div>
        <div className="text-right min-w-[3.5rem]">
          <div className="font-mono font-bold text-lg tabular-nums">{polygon.length}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">points</div>
        </div>
      </div>
    </div>
  );
}
