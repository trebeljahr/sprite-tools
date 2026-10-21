"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { boundedFile, sameOriginFile } from "@/lib/browser-files";
import {
  clipFor,
  frameAt,
  roleDuration,
  roles,
  validateAnimationSet,
  type AnimationSet,
  type Role,
} from "@/lib/playground/set";
import {
  bodyFrame,
  createBody,
  stepBody,
  stepPreview,
  WORLD,
  VIEWPORT,
  strideFor,
  runSpeedFor,
  type Input,
  type Preview,
} from "@/lib/playground/controller";

import { cameraFor, paintScene } from "@/lib/playground/scene";

const labels: Record<Role, string> = {
  idle: "Idle",
  walk: "Walk",
  run: "Run",
  jump: "Jump",
  roll: "Roll",
  attack1: "Attack 1",
  attack2: "Attack 2",
  attack3: "Attack 3",
};
const emptyInput = (): Input => ({
  axis: 0,
  sprint: false,
  jump: false,
  roll: false,
  attack: false,
});
type Loaded = { set: AnimationSet; images: Record<string, HTMLImageElement>; url: string };
function paintSprite(
  ctx: CanvasRenderingContext2D,
  loaded: Loaded,
  role: Role,
  frame: number,
  x: number,
  y: number,
  facing: number,
  time: number,
) {
  const { set, images } = loaded,
    { id, clip, fallback } = clipFor(set, role),
    im = images[id],
    w = set.canvas.width,
    h = set.canvas.height;
  const color = clip.colour ?? { saturation: 1, contrast: 1, brightness: 1 };
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.filter = `saturate(${color.saturation}) contrast(${color.contrast}) brightness(${color.brightness})`;
  if (role === "roll" && fallback) {
    ctx.translate(0, -55);
    ctx.rotate((time / roleDuration(set, "roll")) * Math.PI * 2);
    ctx.scale(0.65, 0.65);
    ctx.translate(0, 120);
  }
  ctx.scale(1.15, 1.15);
  const renderFrame = role === "roll" && fallback ? 0 : frame;
  if (role === "walk" || role === "run")
    ctx.translate(0, clip.locomotion?.groundOffsets?.[renderFrame] ?? 0);
  ctx.drawImage(
    im,
    (renderFrame % clip.grid.cols) * w,
    Math.floor(renderFrame / clip.grid.cols) * h,
    w,
    h,
    -set.origin.x,
    -set.origin.y,
    w,
    h,
  );
  ctx.restore();
}
export default function Playground() {
  const [loaded, setLoaded] = useState<Loaded | null>(null),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const [loadProgress, setLoadProgress] = useState("");
  const [mode, setMode] = useState<"play" | "clips">("play"),
    [active, setActive] = useState(false),
    [playing, setPlaying] = useState(true),
    [speed, setSpeed] = useState(1),
    [queued, setQueued] = useState(true),
    [from, setFrom] = useState<Role>("run"),
    [to, setTo] = useState<Role>("jump"),
    [view, setView] = useState({
      role: "idle",
      frame: 0,
      x: 180,
      y: 500,
      speed: 0,
      facing: 1,
      queued: "",
    });
  const canvas = useRef<HTMLCanvasElement>(null),
    body = useRef(createBody()),
    input = useRef(emptyInput()),
    keys = useRef(new Set<string>()),
    preview = useRef<Preview>({ role: "idle", time: 0, queued: null }),
    loadRequest = useRef<AbortController | null>(null);
  const held = useRef({ left: false, right: false, sprint: false });
  const clear = useCallback(() => {
    keys.current.clear();
    held.current = { left: false, right: false, sprint: false };
    input.current = emptyInput();
  }, []);
  const load = useCallback(
    async (path: string) => {
      loadRequest.current?.abort();
      const ac = new AbortController();
      loadRequest.current = ac;
      setBusy(true);
      setError("");
      setActive(false);
      clear();
      try {
        const file = sameOriginFile(path, location.href),
          bytes = await boundedFile(file, 1024 * 1024, ac.signal),
          set = validateAnimationSet(JSON.parse(new TextDecoder().decode(bytes))),
          images: Record<string, HTMLImageElement> = {};
        let completed = 0;
        for (const [id, clip] of Object.entries(set.clips)) {
          setLoadProgress(`${completed} / ${Object.keys(set.clips).length} · ${id}`);
          if (ac.signal.aborted) return;
          const data = await boundedFile(
            sameOriginFile(clip.sheet, file),
            32 * 1024 * 1024,
            ac.signal,
          );
          if (data.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
            throw Error("Animation sheets must be PNG files.");
          const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
          if (
            header.getUint32(16) !== set.canvas.width * clip.grid.cols ||
            header.getUint32(20) !== set.canvas.height * clip.grid.rows
          )
            throw Error(`${id}: sheet dimensions do not match its grid.`);
          const im = new Image(),
            objectUrl = URL.createObjectURL(
              new Blob([new Uint8Array(data)], { type: "image/png" }),
            );
          try {
            im.src = objectUrl;
            await im.decode();
            images[id] = im;
            completed++;
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
        if (ac.signal.aborted) return;
        setLoaded({ set, images, url: file });
        setUrl(file);
        body.current = createBody();
        preview.current = { role: "idle", time: 0, queued: null };
        setView({ role: "idle", frame: 0, x: 180, y: 500, speed: 0, facing: 1, queued: "" });
      } catch (e) {
        if (!ac.signal.aborted)
          setError(e instanceof Error ? e.message : "Animation set could not be loaded.");
      } finally {
        if (loadRequest.current === ac) setBusy(false);
      }
    },
    [clear],
  );
  useEffect(() => {
    const path = new URLSearchParams(window.location.search).get("set");
    if (path) void load(path);
    else setBusy(false);
    return () => loadRequest.current?.abort();
  }, [load]);
  useEffect(() => {
    const stop = () => {
      clear();
      setActive(false);
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clear]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0,
      last = 0,
      accumulator = 0,
      report = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!loaded) paintScene(ctx, { x: -460, y: 0 }, mode === "play");
      if (loaded) {
        let role: Role, frame: number, x: number, y: number, facing: number, time: number;
        if (mode === "play") {
          {
            accumulator += dt;
            let first = true;
            while (accumulator >= 1 / 120) {
              const i = active
                ? {
                    ...input.current,
                    axis: Number(held.current.right) - Number(held.current.left),
                    sprint: held.current.sprint,
                  }
                : emptyInput();
              if (!first) {
                i.jump = false;
                i.roll = false;
                i.attack = false;
              }
              body.current = stepBody(body.current, i, 1 / 120, loaded.set);
              if (first) {
                input.current.jump = false;
                input.current.roll = false;
                input.current.attack = false;
              }
              first = false;
              accumulator -= 1 / 120;
            }
          }
          const s = body.current,
            p = bodyFrame(s, loaded.set);
          role = p.role;
          frame = p.frame;
          x = s.x;
          y = s.y;
          facing = s.facing;
          time = s.time;
        } else {
          if (playing) preview.current = stepPreview(preview.current, dt * speed, loaded.set);
          const p = preview.current;
          role = p.role;
          frame = frameAt(loaded.set, role, p.time, clipFor(loaded.set, role).clip.loop);
          x = VIEWPORT.width / 2;
          y = WORLD.ground;
          facing = 1;
          time = p.time;
        }
        const camera = mode === "play" ? cameraFor(x, y) : { x: 0, y: 0 };
        paintScene(ctx, camera, mode === "play");
        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        ctx.fillStyle = "#84725422";
        ctx.beginPath();
        ctx.ellipse(x, Math.min(WORLD.ground, y) + 3, 28, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        const from =
          mode === "play" && body.current.motion === "settle" ? body.current.settleFrom : null;
        if (from) {
          const t = Math.min(1, time / 0.18),
            blend = t * t * (3 - 2 * t);
          ctx.save();
          ctx.globalAlpha = 1 - blend;
          paintSprite(ctx, loaded, from.role, from.frame, x, y, facing, 0);
          ctx.globalAlpha = blend;
          paintSprite(ctx, loaded, "idle", frame, x, y, facing, time);
          ctx.restore();
        } else paintSprite(ctx, loaded, role, frame, x, y, facing, time);
        ctx.restore();
        c.dataset.state = mode === "play" ? body.current.motion : role;
        c.dataset.frame = String(frame);
        c.dataset.x = x.toFixed(1);
        c.dataset.y = y.toFixed(1);
        if (now - report > 80) {
          report = now;
          setView({
            role: mode === "play" ? body.current.motion : role,
            frame,
            x: Math.round(x),
            y: Math.round(y),
            speed: mode === "play" ? Math.round(body.current.vx) : 0,
            facing,
            queued:
              mode === "play"
                ? body.current.queuedStab
                  ? "stab"
                  : ""
                : (preview.current.queued ?? ""),
          });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loaded, active, mode, playing, speed]);
  const scrub = (frame: number) => {
    if (!loaded) return;
    const p = preview.current,
      { clip, fallback } = clipFor(loaded.set, p.role);
    const index = (frame + clip.count) % clip.count;
    p.time =
      clip.durations.slice(0, index).reduce((a, b) => a + b, 0) /
        1000 /
        (p.role === "run" && fallback ? 1.65 : 1) +
      0.000001;
    p.queued = null;
    setPlaying(false);
  };
  const key = (e: React.KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    const code = e.code;
    if (mode === "clips") {
      if (!down || !["Space", "ArrowLeft", "ArrowRight"].includes(code)) return;
      e.preventDefault();
      if (code === "Space") setPlaying(!playing);
      else scrub(view.frame + (code === "ArrowRight" ? 1 : -1));
      return;
    }
    if (
      ![
        "KeyA",
        "KeyD",
        "KeyW",
        "KeyS",
        "KeyE",
        "KeyF",
        "Space",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ShiftLeft",
        "ShiftRight",
        "Escape",
      ].includes(code)
    )
      return;
    e.preventDefault();
    if (code === "Escape") {
      clear();
      setActive(false);
      e.currentTarget.blur();
      return;
    }
    if (down) keys.current.add(code);
    else keys.current.delete(code);
    held.current.left = keys.current.has("KeyA") || keys.current.has("ArrowLeft");
    held.current.right = keys.current.has("KeyD") || keys.current.has("ArrowRight");
    // Embedded browsers can forward Shift only as a modifier on movement events.
    held.current.sprint =
      e.shiftKey || keys.current.has("ShiftLeft") || keys.current.has("ShiftRight");
    if (down && !e.repeat) {
      if (["KeyW", "Space", "ArrowUp"].includes(code)) input.current.jump = true;
      if (["KeyS", "KeyE"].includes(code)) input.current.roll = true;
      if (code === "KeyF") input.current.attack = true;
    }
  };
  const choose = (role: Role) => {
    if (queued && playing) preview.current.queued = role;
    else preview.current = { role, time: 0, queued: null };
    setPlaying(true);
  };
  const reset = () => {
    clear();
    body.current = createBody();
    preview.current = { role: "idle", time: 0, queued: null };
    setActive(false);
  };
  const colourId = loaded
    ? clipFor(
        loaded.set,
        (view.role === "land" ? "jump" : view.role === "settle" ? "idle" : view.role) as Role,
      ).id
    : null;
  const grade =
    colourId && loaded
      ? (loaded.set.clips[colourId].colour ?? { saturation: 1, contrast: 1, brightness: 1 })
      : null;
  const updateColour = (field: "saturation" | "contrast" | "brightness", value: number) => {
    if (!loaded || !colourId || !grade) return;
    setLoaded({
      ...loaded,
      set: {
        ...loaded.set,
        clips: {
          ...loaded.set.clips,
          [colourId]: { ...loaded.set.clips[colourId], colour: { ...grade, [field]: value } },
        },
      },
    });
  };
  const save = () => {
    if (!loaded) return;
    const out = {
      ...loaded.set,
      clips: Object.fromEntries(
        Object.entries(loaded.set.clips).map(([id, c]) => [
          id,
          { ...c, sheet: new URL(c.sheet, loaded.url).pathname },
        ]),
      ),
      controller: { ...loaded.set.controller, bindings: loaded.set.bindings },
    };
    const u = URL.createObjectURL(
        new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = u;
    a.download = "animation-set.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  };
  const names = { ...labels, ...loaded?.set.controller?.labels };
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 py-7 lg:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-xs uppercase tracking-[.18em] text-muted-foreground">
            Animation & movement
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {loaded?.set.character ?? "Sprite"} playground
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Test movement, action timing and transitions with the same sprite set.
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" disabled={!loaded} onClick={save}>
            Save set settings
          </Button>
          {loaded?.set.controller?.layerProject && (
            <a
              className="self-center text-sm underline"
              href={`/character-layers?project=${encodeURIComponent(loaded.set.controller.layerProject)}`}
            >
              Layer editor
            </a>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-y py-3">
        <Button
          variant={mode === "play" ? "default" : "ghost"}
          onClick={() => {
            clear();
            setActive(false);
            setMode("play");
          }}
        >
          Play controller
        </Button>
        <Button
          variant={mode === "clips" ? "default" : "ghost"}
          onClick={() => {
            clear();
            setActive(false);
            setMode("clips");
          }}
        >
          Clips & transitions
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={reset}>
          Reset
        </Button>
        {mode === "clips" && (
          <Button variant="outline" onClick={() => setPlaying(!playing)}>
            {playing ? "Pause" : "Play"}
          </Button>
        )}
      </div>
      <div className="relative overflow-hidden bg-[#eee4ce]">
        <canvas
          ref={canvas}
          width={VIEWPORT.width}
          height={VIEWPORT.height}
          tabIndex={0}
          aria-label="Sprite playground. A and D move, Shift runs, W or Space jumps, S or E rolls, F attacks."
          className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          onFocus={() => {
            if (loaded && mode === "play") setActive(true);
          }}
          onPointerDown={(e) => e.currentTarget.focus()}
          onBlur={() => {
            clear();
            setActive(false);
          }}
          onKeyDown={(e) => key(e, true)}
          onKeyUp={(e) => key(e, false)}
        />
        {(!loaded || busy) && (
          <p className="absolute inset-0 flex items-center justify-center bg-[#eee4ce]/90 p-6 text-center text-sm text-[#756c5d]">
            {busy
              ? `Loading sprite sheets… ${loadProgress}`
              : "Open an animation set below to begin."}
          </p>
        )}
        {loaded && mode === "play" && !active && (
          <button
            type="button"
            className="absolute bottom-4 left-4 rounded border border-[#b5aa94] bg-[#eee4ce]/95 px-5 py-3 text-sm text-[#302c28]"
            onClick={() => canvas.current?.focus()}
          >
            Click to play · WASD + F
          </button>
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-y py-3 text-xs text-muted-foreground">
        <output aria-label="Controller state" aria-live="off">
          {view.role.toUpperCase()} · frame {view.frame + 1}
          {view.queued ? ` → ${view.queued}` : ""}
        </output>
        <output aria-label="Player position" aria-live="off">
          x {view.x} · y {view.y} · {view.speed} px/s · facing{" "}
          {view.facing === 1 ? "right" : "left"}
        </output>
      </div>
      {mode === "play" ? (
        <>
          <p className="mt-3 text-sm text-muted-foreground">
            <b>A / D</b> move · <b>Shift</b> run · <b>W / Space</b> jump · <b>S / E</b> roll ·{" "}
            <b>F</b> attack · <b>Esc</b> release keys
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Walk and run cadence follows distance travelled. Explore left and right through the
            woodland. Keep a direction held through a jump. Press F during a roll to queue a stab.
            Press F again near the end of an attack to chain the next attack.
          </p>
          {loaded && (
            <label className="mt-4 flex max-w-lg flex-wrap items-center gap-3 text-sm">
              Run speed · {runSpeedFor(loaded.set)} px/s
              <input
                aria-label="Run speed"
                type="range"
                min={400}
                max={2400}
                step={100}
                value={runSpeedFor(loaded.set)}
                className="min-w-40 flex-1"
                onChange={(e) => {
                  const runSpeed = Number(e.target.value);
                  setLoaded((current) =>
                    current
                      ? {
                          ...current,
                          set: {
                            ...current.set,
                            controller: { ...current.set.controller, runSpeed },
                          },
                        }
                      : current,
                  );
                }}
              />
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                ["←", "left"],
                ["→", "right"],
                ["Run", "sprint"],
                ["Jump", "jump"],
                ["Roll", "roll"],
                ["Attack", "attack"],
              ] as const
            ).map(([label, action]) => (
              <Button
                key={action}
                variant="outline"
                disabled={!loaded}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setActive(true);
                  if (action in held.current)
                    held.current[action as keyof typeof held.current] = true;
                  else input.current[action as "jump" | "roll" | "attack"] = true;
                }}
                onPointerUp={() => {
                  if (action in held.current)
                    held.current[action as keyof typeof held.current] = false;
                }}
                onPointerCancel={() => clear()}
              >
                {label}
              </Button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-4 py-4">
          <div className="flex flex-wrap gap-2">
            {roles.map((role) => (
              <Button
                key={role}
                variant={view.role === role ? "default" : "ghost"}
                disabled={!loaded}
                onClick={() => choose(role)}
              >
                {names[role]}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              aria-label="Previous frame"
              disabled={!loaded}
              onClick={() => scrub(view.frame - 1)}
            >
              ←
            </Button>
            <Button
              variant="ghost"
              aria-label="Next frame"
              disabled={!loaded}
              onClick={() => scrub(view.frame + 1)}
            >
              →
            </Button>
            <input
              aria-label="Animation frame"
              type="range"
              className="min-w-24 flex-1"
              min={0}
              max={loaded ? clipFor(loaded.set, preview.current.role).clip.count - 1 : 0}
              value={view.frame}
              onChange={(e) => scrub(Number(e.target.value))}
            />
            <span className="text-xs text-muted-foreground">
              {view.frame + 1} / {loaded ? clipFor(loaded.set, preview.current.role).clip.count : 0}
            </span>
            <select
              aria-label="Playback speed"
              className="rounded border bg-background p-2 text-sm"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              {[0.25, 0.5, 1, 2].map((s) => (
                <option key={s} value={s}>
                  {s}× speed
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={queued} onChange={(e) => setQueued(e.target.checked)} />{" "}
            Switch at clip end
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              From{" "}
              <select
                aria-label="Transition from"
                className="ml-2 rounded border bg-background p-2"
                value={from}
                onChange={(e) => setFrom(e.target.value as Role)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {names[r]}
                  </option>
                ))}
              </select>
            </label>
            <span>→</span>
            <label className="text-sm">
              To{" "}
              <select
                aria-label="Transition to"
                className="ml-2 rounded border bg-background p-2"
                value={to}
                onChange={(e) => setTo(e.target.value as Role)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {names[r]}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!loaded}
              onClick={() => {
                preview.current = { role: from, time: 0, queued: to };
                setPlaying(true);
              }}
            >
              Preview transition
            </Button>
          </div>
        </div>
      )}
      {loaded && (!loaded.set.bindings.run || !loaded.set.bindings.roll) && (
        <p className="mt-4 text-xs text-amber-600">
          Temporary visuals: {!loaded.set.bindings.run ? "run uses a faster walk cycle. " : ""}
          {!loaded.set.bindings.roll
            ? "Roll uses a transformed idle pose. Replace these bindings with authored clips for production."
            : ""}
        </p>
      )}
      <details className="mt-5 border-y py-4">
        <summary className="cursor-pointer text-sm font-medium">
          Animation bindings & colour
        </summary>
        {loaded && (
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            <div className="grid grid-cols-2 gap-3">
              {roles.map((role) => (
                <label key={role} className="text-xs text-muted-foreground">
                  {names[role]}
                  <select
                    className="mt-1 block w-full rounded border bg-background p-2 text-foreground"
                    aria-label={`${names[role]} clip`}
                    value={loaded.set.bindings[role] ?? ""}
                    onChange={(e) => {
                      setLoaded({
                        ...loaded,
                        set: {
                          ...loaded.set,
                          bindings: { ...loaded.set.bindings, [role]: e.target.value || null },
                        },
                      });
                      reset();
                    }}
                  >
                    <option value="">Preview fallback</option>
                    {Object.keys(loaded.set.clips).map((id) => (
                      <option key={id}>{id}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {grade && (
              <div className="space-y-4">
                <p className="text-sm">Colour · {colourId}</p>
                {(["saturation", "contrast", "brightness"] as const).map((field) => (
                  <label key={field} className="block text-xs capitalize text-muted-foreground">
                    {field} · {Math.round(grade[field] * 100)}%
                    <input
                      aria-label={`Clip ${field}`}
                      className="mt-2 block w-full"
                      type="range"
                      min={field === "saturation" ? 0 : 50}
                      max={field === "saturation" ? 200 : 150}
                      value={grade[field] * 100}
                      onChange={(e) => updateColour(field, Number(e.target.value) / 100)}
                    />
                  </label>
                ))}
                {(view.role === "walk" || view.role === "run") && (
                  <label className="block text-xs text-muted-foreground">
                    Stride distance · {strideFor(loaded.set, view.role)} px per cycle
                    <input
                      aria-label="Stride distance"
                      className="mt-2 block w-full"
                      type="range"
                      min={80}
                      max={600}
                      step={10}
                      value={strideFor(loaded.set, view.role)}
                      onChange={(e) => {
                        const clip = loaded.set.clips[colourId!];
                        setLoaded({
                          ...loaded,
                          set: {
                            ...loaded.set,
                            clips: {
                              ...loaded.set.clips,
                              [colourId!]: {
                                ...clip,
                                locomotion: {
                                  ...clip.locomotion,
                                  phaseOffset: clip.locomotion?.phaseOffset ?? 0,
                                  stridePixels: Number(e.target.value),
                                },
                              },
                            },
                          },
                        });
                      }}
                    />
                    <span className="mt-1 block">
                      Smaller strides quicken the feet in the controller. Clip review keeps the
                      source timing.
                    </span>
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  Adjustments affect only the selected clip in this preview. Source PNGs stay
                  unchanged. Save set settings to keep them.
                </p>
              </div>
            )}
          </div>
        )}
      </details>
      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load(url);
        }}
      >
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          Animation set URL
          <input
            aria-label="Animation set URL"
            className="mt-1 block w-full rounded border bg-background p-2 text-sm text-foreground"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="/sprites/animation-set.json"
          />
        </label>
        <Button disabled={!url || busy}>Open set</Button>
      </form>
      <p className="mt-4 text-xs text-muted-foreground">
        Controller prototype. Movement and one-way platforms use simple physics; this preview does
        not export a finished game controller or production hitboxes.
      </p>
    </main>
  );
}
