"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { characterManifest, poseTransforms, prepareCharacter } from "@/lib/character/core";
import { CHARACTER_AI, completeCharacterPart, draftCharacterPlan } from "@/lib/character/ai";
import {
  croppedCanvas,
  importCharacterZip,
  decodeCharacterImage,
  exportCharacterZip,
  imageCanvas,
  sessionStore,
  sha256,
  type CharacterSession,
} from "@/lib/character/browser";
import { characterDemo } from "@/lib/character/demo";
import { completionBackground, removeCompletionBackground } from "@/lib/character/completion";
import { validatePlan, type CharacterPart, type Point } from "@/lib/character/types";

type View = "assembled" | "original" | "exploded" | "bend";
type Edit = "inspect" | "polygon" | "pivot" | "tip" | "origin";
const colors = ["#b46d3c", "#497c8f", "#8a6caa", "#5f8c62", "#b5556d", "#a58a36"];
const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
export default function CharacterLayersPage() {
  const [session, setSession] = useState<CharacterSession | null>(null),
    [selected, setSelected] = useState(""),
    [view, setView] = useState<View>("assembled"),
    [edit, setEdit] = useState<Edit>("inspect");
  const [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(""),
    [ready, setReady] = useState(false),
    [apiKey, setApiKey] = useState(""),
    [description, setDescription] = useState("");
  const [exportUrl, setExportUrl] = useState("");
  const [planOpen, setPlanOpen] = useState(false),
    [planJson, setPlanJson] = useState("");
  useEffect(
    () => () => {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
    },
    [exportUrl],
  );
  const [maskDraft, setMaskDraft] = useState<Point[] | null>(null);
  const [angle, setAngle] = useState(0),
    [animate, setAnimate] = useState(false),
    [showMasks, setShowMasks] = useState(false),
    [showGenerated, setShowGenerated] = useState(false),
    [keyOpen, setKeyOpen] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    drag = useRef<number | null>(null),
    controller = useRef<AbortController | null>(null),
    revision = useRef(0),
    history = useRef<CharacterSession[]>([]),
    future = useRef<CharacterSession[]>([]),
    fileRef = useRef<HTMLInputElement>(null),
    planRef = useRef<HTMLInputElement>(null),
    completionRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false),
    cache = useRef(new Map<string, unknown>());
  useEffect(() => {
    let active = true;
    sessionStore()
      .then((s) => {
        if (active && s && revision.current === 0) {
          setSession(s);
          setSelected(s.plan.parts.at(-1)?.id ?? "");
        }
      })
      .catch(() =>
        setStatus("Local draft storage is unavailable. Export your project before closing."),
      )
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready || !session) return;
    const timer = setTimeout(() => {
      void sessionStore(session).catch(() =>
        setStatus("Draft could not be saved locally. Export the project to keep it."),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [session, ready]);
  const bundle = useMemo(() => {
    if (!session) return null;
    try {
      return prepareCharacter(
        session.source,
        session.plan,
        session.completions,
        session.completionKinds ?? {},
      );
    } catch {
      return null;
    }
  }, [session]);
  const part = session?.plan.parts.find((p) => p.id === selected),
    layer = bundle?.layers.find((l) => l.id === selected);
  const canvases = useMemo(
    () =>
      bundle
        ? Object.fromEntries(
            bundle.layers.map((l) => [l.id, croppedCanvas(showGenerated ? l.generated : l.image)]),
          )
        : {},
    [bundle, showGenerated],
  );
  const sourceCanvas = useMemo(
    () => (session ? imageCanvas(session.source) : null),
    [session?.source, session],
  );
  const commit = (next: CharacterSession, record = true) => {
    try {
      validatePlan(next.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid project.");
      return;
    }
    if (record && session) {
      history.current = [...history.current.slice(-19), session];
      future.current = [];
    }
    revision.current++;
    if (!next.plan.parts.some((p) => p.id === selected)) setSelected(next.plan.parts.at(-1)!.id);
    setExportUrl("");
    setSession(next);
    setError("");
  };
  const updatePart = (patch: Partial<CharacterPart>, record = true) => {
    if (!session || !part) return;
    const next = {
      ...session,
      plan: {
        ...session.plan,
        parts: session.plan.parts.map((p) => (p.id === selected ? { ...p, ...patch } : p)),
      },
    };
    try {
      validatePlan(next.plan);
      commit(next, record);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid edit.");
    }
  };
  const undo = () => {
    const prev = history.current.pop();
    if (prev && session) {
      future.current.push(session);
      commit(prev, false);
    }
  };
  const redo = () => {
    const next = future.current.pop();
    if (next && session) {
      history.current.push(session);
      commit(next, false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        !/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName) &&
        !busyRef.current
      ) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    if (!animate) return;
    let id = 0,
      start = 0;
    const tick = (t: number) => {
      start ||= t;
      setAngle(Math.sin((t - start) / 800) * 35);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [animate]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !session || !bundle) return;
    const ctx = c.getContext("2d")!;
    c.width = session.source.width;
    c.height = session.source.height;
    ctx.clearRect(0, 0, c.width, c.height);
    const transforms = poseTransforms(session.plan, view === "bend" ? { [selected]: angle } : {});
    if (view === "original" && sourceCanvas) ctx.drawImage(sourceCanvas, 0, 0);
    else
      for (const [_i, l] of bundle.layers.entries()) {
        ctx.save();
        if (view === "exploded") {
          const p = session.plan.parts.find((p) => p.id === l.id);
          if (p) {
            const b = p.polygon.reduce(
              (a, b) => ({ x: a.x + b.x / p.polygon.length, y: a.y + b.y / p.polygon.length }),
              { x: 0, y: 0 },
            );
            ctx.translate((b.x - c.width / 2) * 0.35, (b.y - c.height / 2) * 0.25);
          }
        } else if (view === "bend" && transforms[l.id]) ctx.transform(...transforms[l.id]);
        const im = canvases[l.id];
        if (im?.canvas.width && im.canvas.height) ctx.drawImage(im.canvas, im.x, im.y);
        ctx.restore();
      }
    if (view !== "exploded" && view !== "original" && view !== "bend" && part && showMasks) {
      ctx.save();
      ctx.strokeStyle =
        colors[
          Math.max(
            0,
            session.plan.parts.findIndex((p) => p.id === selected),
          ) % colors.length
        ];
      ctx.fillStyle = `${ctx.strokeStyle}20`;
      ctx.lineWidth = Math.max(1, c.width / 450);
      ctx.beginPath();
      (maskDraft ?? part.polygon).forEach((p, i) => {
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (const p of maskDraft ?? part.polygon) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, c.width / 180, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
      ctx.restore();
    }
    if (part && view !== "exploded" && view !== "original") {
      ctx.save();
      if (view === "bend" && transforms[selected]) ctx.transform(...transforms[selected]);
      ctx.strokeStyle = "#d27b32";
      ctx.lineWidth = Math.max(1.5, c.width / 350);
      ctx.beginPath();
      ctx.moveTo(part.pivot.x, part.pivot.y);
      ctx.lineTo(part.tip.x, part.tip.y);
      ctx.stroke();
      for (const [p, color] of [
        [part.pivot, "#d27b32"],
        [part.tip, "#4593b0"],
      ] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, c.width / 110, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.strokeStyle = "#b0824a";
    ctx.lineWidth = Math.max(1, c.width / 500);
    const o = session.plan.origin,
      r = c.width / 70;
    ctx.beginPath();
    ctx.moveTo(o.x - r, o.y);
    ctx.lineTo(o.x + r, o.y);
    ctx.moveTo(o.x, o.y - r);
    ctx.lineTo(o.x, o.y + r);
    ctx.stroke();
  }, [session, bundle, canvases, view, part, selected, angle, showMasks, sourceCanvas, maskDraft]);
  const location = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const c = e.currentTarget,
      r = c.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(c.width, ((e.clientX - r.left) * c.width) / r.width)),
      y: Math.max(0, Math.min(c.height, ((e.clientY - r.top) * c.height) / r.height)),
    };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!session || busy || view !== "assembled") return;
    const p = location(e);
    if (edit === "origin") {
      commit({ ...session, plan: { ...session.plan, origin: p } });
      return;
    }
    if (!part) return;
    if (edit === "pivot" || edit === "tip") {
      updatePart({ [edit]: p });
      return;
    }
    if (edit === "polygon") {
      const near = part.polygon.findIndex(
        (a) => Math.hypot(a.x - p.x, a.y - p.y) < session.source.width / 45,
      );
      if (near >= 0) {
        setMaskDraft(part.polygon);
        drag.current = near;
        e.currentTarget.setPointerCapture(e.pointerId);
      } else if (e.shiftKey) {
        updatePart({ polygon: [...part.polygon, p] });
      } else
        setStatus(
          "Drag a mask point. Shift-click adds a point; use the inspector to remove the last point.",
        );
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current === null || !part || busy) return;
    setMaskDraft((maskDraft ?? part.polygon).map((p, i) => (i === drag.current ? location(e) : p)));
  };
  const run = async (label: string, fn: (signal: AbortSignal, rev: number) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    const ac = new AbortController();
    controller.current = ac;
    try {
      await fn(ac.signal, revision.current);
    } catch (e) {
      setError(
        ac.signal.aborted
          ? "Request stopped. A dispatched paid request may still be charged; check usage before retrying."
          : e instanceof Error
            ? e.message
            : "Request failed.",
      );
    } finally {
      busyRef.current = false;
      setBusy("");
      controller.current = null;
    }
  };
  const applyPlan = (text: string) => {
    if (!session) return;
    if (text.length > 1024 * 1024) throw new Error("Plan exceeds 1 MB.");
    const value = JSON.parse(text),
      plan = validatePlan(value.plan ?? value);
    if (plan.width !== session.source.width || plan.height !== session.source.height)
      throw new Error("Plan uses a different canvas.");
    commit({ ...session, plan, completions: {}, completionKinds: {} });
    setSelected(plan.parts.at(-1)!.id);
    setPlanOpen(false);
    setStatus("Plan applied locally. Review masks and joints before completing hidden regions.");
  };
  const loadImage = async (file: File) => {
    setPlanOpen(false);
    if (/\.zip$/i.test(file.name)) {
      const loaded = await importCharacterZip(file);
      commit(loaded);
      setSelected(loaded.plan.parts.at(-1)!.id);
      setStatus("Character project restored from ZIP.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) throw new Error("Use an image under 8 MB.");
    const url = URL.createObjectURL(file);
    try {
      const source = await decodeCharacterImage(url);
      const plan = {
        version: 1 as const,
        width: source.width,
        height: source.height,
        origin: { x: source.width / 2, y: source.height },
        parts: [
          {
            id: "body",
            name: "Whole character",
            parent: null,
            pivot: { x: source.width / 2, y: source.height / 2 },
            tip: { x: source.width / 2, y: source.height / 3 },
            polygon: [
              { x: 0, y: 0 },
              { x: source.width, y: 0 },
              { x: source.width, y: source.height },
              { x: 0, y: source.height },
            ],
            description: "Replace with AI draft or reviewed masks.",
          },
        ],
        notes: ["Source imported. Create an AI draft or import a reviewed plan to separate parts."],
      };
      validatePlan(plan);
      commit({ source, plan, completions: {} });
      setSelected("body");
      setView("assembled");
      setAnimate(false);
      setAngle(0);
      setShowMasks(false);
      setShowGenerated(false);
      setStatus("Image loaded locally. Use a transparent source or remove its background first.");
      history.current = [];
      future.current = [];
      cache.current.clear();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const act = (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("Preparing local project…");
    setError("");
    void fn()
      .catch((e) => setError(e instanceof Error ? e.message : "Action failed."))
      .finally(() => {
        busyRef.current = false;
        setBusy("");
      });
  };
  const draft = () =>
    session &&
    run("Drafting layers…", async (signal, rev) => {
      const image = imageCanvas(session.source).toDataURL("image/png"),
        key = await sha256(image + description + CHARACTER_AI.planner);
      let plan = cache.current.get(key) as CharacterSession["plan"] | undefined;
      if (!plan) {
        plan = await draftCharacterPlan(
          { image, width: session.source.width, height: session.source.height, description },
          { apiKey, signal },
        );
        cache.current.set(key, plan);
      }
      if (!signal.aborted && revision.current === rev) {
        commit({ ...session, plan, completions: {} });
        setSelected(plan.parts.at(-1)!.id);
        setStatus(
          "AI polygon draft ready. Correct masks and joints before completing hidden regions.",
        );
      }
    });
  const complete = () =>
    session &&
    part &&
    layer?.hiddenPixels &&
    run("Completing hidden area…", async (signal, rev) => {
      const image = imageCanvas(session.source).toDataURL("image/png"),
        key = await sha256(image + JSON.stringify(part) + CHARACTER_AI.editor);
      let data = cache.current.get(key) as string | undefined;
      if (!data) {
        data = await completeCharacterPart(
          { image, plan: session.plan, part, background: completionBackground(session.source) },
          { apiKey, signal },
        );
        cache.current.set(key, data);
      }
      const im = removeCompletionBackground(
        await decodeCharacterImage(data, session.plan),
        completionBackground(session.source),
      );
      if (!signal.aborted && revision.current === rev) {
        commit({
          ...session,
          completions: { ...session.completions, [part.id]: im },
          completionKinds: { ...session.completionKinds, [part.id]: "generated" },
        });
        setStatus(
          "Completion applied only beneath opaque foreground layers. Check its shape in the bend test.",
        );
      }
    });
  const addPart = () => {
    if (!session) return;
    const w = session.plan.width,
      h = session.plan.height;
    let n = session.plan.parts.length + 1,
      id = `part-${n}`;
    while (session.plan.parts.some((p) => p.id === id)) id = `part-${++n}`;
    commit({
      ...session,
      plan: {
        ...session.plan,
        parts: [
          ...session.plan.parts,
          {
            id,
            name: `Part ${n}`,
            parent: null,
            pivot: { x: w * 0.5, y: h * 0.5 },
            tip: { x: w * 0.5, y: h * 0.65 },
            polygon: [
              { x: w * 0.35, y: h * 0.35 },
              { x: w * 0.65, y: h * 0.35 },
              { x: w * 0.65, y: h * 0.65 },
              { x: w * 0.35, y: h * 0.65 },
            ],
            description: "",
          },
        ],
      },
    });
    setSelected(id);
    setEdit("polygon");
    setShowMasks(true);
    setView("assembled");
  };
  const removePart = () => {
    if (!session || !part || session.plan.parts.length < 2) return;
    const parts = session.plan.parts
      .filter((p) => p.id !== selected)
      .map((p) => (p.parent === selected ? { ...p, parent: part.parent } : p));
    const completions = { ...session.completions };
    delete completions[selected];
    commit({ ...session, plan: { ...session.plan, parts }, completions });
    setSelected(parts.at(-1)!.id);
  };
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 py-7 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-xs uppercase tracking-[.18em] text-muted-foreground">
            Character preparation
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Character Layers</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Separate artwork, complete hidden joints, and inspect the bends.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!!busy} onClick={() => fileRef.current?.click()}>
            Open image / project
          </Button>
          <Button
            disabled={!bundle || !!busy}
            onClick={() =>
              act(async () => {
                if (bundle && session) {
                  const blob = await exportCharacterZip(
                    bundle,
                    session.source,
                    session.completions,
                  );
                  setExportUrl(URL.createObjectURL(blob));
                  setStatus(
                    "Project ZIP ready. Download it to keep the source, masks, joints and completion artwork together.",
                  );
                }
              })
            }
          >
            Export layers
          </Button>
          {exportUrl && (
            <a
              className="self-center text-sm underline"
              href={exportUrl}
              download="character-layers.zip"
            >
              Download project ZIP
            </a>
          )}
        </div>
      </header>
      <input
        ref={fileRef}
        aria-label="Character image"
        type="file"
        accept="image/png,image/jpeg,image/webp,.zip"
        className="hidden"
        disabled={!!busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) act(() => loadImage(f));
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={planRef}
        aria-label="Character plan or saved project"
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && session)
            act(async () => {
              if (f.size > 1024 * 1024) throw new Error("Plan exceeds 1 MB.");
              applyPlan(await f.text());
            });
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={completionRef}
        aria-label="Aligned completion PNG"
        type="file"
        accept="image/png"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && session && part)
            act(async () => {
              if (f.size > 8 * 1024 * 1024) throw new Error("Completion exceeds 8 MB.");
              const url = URL.createObjectURL(f);
              try {
                const im = await decodeCharacterImage(url);
                if (im.width !== session.plan.width || im.height !== session.plan.height)
                  throw new Error("Import a PNG on the exact source canvas.");
                commit({
                  ...session,
                  completions: { ...session.completions, [part.id]: im },
                  completionKinds: { ...session.completionKinds, [part.id]: "imported" },
                });
              } finally {
                URL.revokeObjectURL(url);
              }
            });
          e.currentTarget.value = "";
        }}
      />
      {error && (
        <p
          role="alert"
          className="mb-4 border-l-2 border-destructive pl-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid min-h-[580px] grid-cols-1 border-y lg:grid-cols-[190px_minmax(0,1fr)_280px]">
        <aside className="border-b py-4 lg:border-r lg:border-b-0 lg:pr-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">Layers</h2>
            <button
              type="button"
              className="text-xs underline disabled:opacity-40"
              disabled={
                !session ||
                !!busy ||
                session.plan.parts.length >=
                  Math.min(32, Math.floor(32_000_000 / (session.plan.width * session.plan.height)))
              }
              onClick={addPart}
            >
              Add
            </button>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">Front to back</p>
          <div className="flex gap-1 overflow-auto lg:max-h-[560px] lg:flex-col">
            {session ? (
              [...session.plan.parts].reverse().map((p, i) => (
                <button
                  type="button"
                  key={p.id}
                  disabled={!!busy}
                  aria-pressed={p.id === selected}
                  onClick={() => {
                    setSelected(p.id);
                    setAnimate(false);
                    setAngle(0);
                  }}
                  className={`flex shrink-0 items-center gap-2 rounded px-2 py-2 text-left text-sm ${selected === p.id ? "bg-accent font-medium" : "hover:bg-muted"}`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: colors[(session.plan.parts.length - i - 1) % colors.length],
                    }}
                  />
                  {p.name}
                </button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Open artwork to begin.</p>
            )}
          </div>
          {bundle?.report.unassignedPixels ? (
            <p className="mt-3 text-xs text-amber-700">
              {bundle.report.unassignedPixels.toLocaleString()} unassigned pixels preserved
              separately.
            </p>
          ) : null}
        </aside>
        <section className="flex min-w-0 flex-col lg:px-5">
          <div className="flex flex-wrap gap-1 border-b py-3">
            {(
              [
                ["assembled", "Assembled"],
                ["original", "Original"],
                ["exploded", "Exploded"],
                ["bend", "Bend test"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                key={id}
                aria-pressed={view === id}
                disabled={!session}
                onClick={() => {
                  setView(id);
                  setEdit("inspect");
                  setAnimate(false);
                  setAngle(0);
                }}
                className={`rounded px-3 py-1.5 text-xs ${view === id ? "bg-foreground text-background" : "hover:bg-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex min-h-[420px] flex-1 items-center justify-center overflow-hidden bg-[linear-gradient(45deg,#b6ae9b12_25%,transparent_25%,transparent_75%,#b6ae9b12_75%),linear-gradient(45deg,#b6ae9b12_25%,transparent_25%,transparent_75%,#b6ae9b12_75%)] [background-size:24px_24px] [background-position:0_0,12px_12px]">
            {session ? (
              <canvas
                ref={canvas}
                aria-label="Character layer editing canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={() => {
                  if (maskDraft) updatePart({ polygon: maskDraft });
                  drag.current = null;
                  setMaskDraft(null);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setMaskDraft(null);
                }}
                className={`max-h-[62vh] max-w-full touch-none object-contain ${edit !== "inspect" ? "cursor-crosshair" : ""}`}
                style={{ width: "auto", height: "auto" }}
              />
            ) : (
              <div className="px-8 text-center">
                <p className="text-xl font-medium">One drawing. Editable parts.</p>
                <p className="mx-auto mt-3 max-w-xs text-sm text-muted-foreground">
                  Open artwork for a character, creature, or articulated object. Keep its style
                  while separating parts for animation.
                </p>
                <button
                  type="button"
                  className="mt-5 text-xs underline"
                  disabled={!!busy}
                  onClick={() => {
                    commit(characterDemo());
                    setSelected("forearm");
                    setStatus(
                      "Joint-test sample. Geometric artwork, masks and hidden pixels are authored test data.",
                    );
                  }}
                >
                  Try geometric joint-test sample
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t py-3 text-xs text-muted-foreground">
            <span>
              {session
                ? `${session.plan.width} × ${session.plan.height} · ${bundle?.report.changedPixels ?? 0} changed rest-pose pixels`
                : ready
                  ? "Images stay local until you choose an AI action."
                  : "Restoring local draft…"}
            </span>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={!history.current.length || !!busy}
                onClick={undo}
                className="disabled:opacity-30"
              >
                Undo
              </button>
              <button
                type="button"
                disabled={!future.current.length || !!busy}
                onClick={redo}
                className="disabled:opacity-30"
              >
                Redo
              </button>
            </div>
          </div>
          {view === "bend" && (
            <div className="flex items-center gap-3 border-t py-3 text-xs">
              <button type="button" onClick={() => setAnimate(!animate)}>
                {animate ? "Pause" : "Animate bend"}
              </button>
              <input
                aria-label="Joint rotation"
                type="range"
                min="-90"
                max="90"
                value={angle}
                onChange={(e) => {
                  setAnimate(false);
                  setAngle(Number(e.target.value));
                }}
                className="min-w-0 flex-1"
              />
              <output>{Math.round(angle)}°</output>
              <button
                type="button"
                onClick={() => {
                  setAnimate(false);
                  setAngle(0);
                }}
              >
                Reset
              </button>
            </div>
          )}
        </section>
        <aside className="space-y-4 border-t py-4 lg:border-t-0 lg:border-l lg:pl-5">
          <h2 className="text-sm font-medium">{part?.name ?? "Part inspector"}</h2>
          {part && session && (
            <fieldset disabled={!!busy} className="space-y-4 disabled:opacity-60">
              <label className="block text-xs text-muted-foreground">
                Name
                <input
                  className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm text-foreground"
                  value={part.name}
                  onChange={(e) => updatePart({ name: e.target.value })}
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Parent joint
                <select
                  className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm text-foreground"
                  value={part.parent ?? ""}
                  onChange={(e) => updatePart({ parent: e.target.value || null })}
                >
                  <option value="">Character origin</option>
                  {session.plan.parts
                    .filter((p) => p.id !== part.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block text-xs text-muted-foreground">
                Edit on canvas
                <select
                  aria-label="Canvas edit tool"
                  className="mt-1 w-full rounded border bg-background px-2 py-1.5 text-sm text-foreground"
                  value={edit}
                  onChange={(e) => {
                    setEdit(e.target.value as Edit);
                    if (e.target.value === "polygon") setShowMasks(true);
                    setView("assembled");
                    setAnimate(false);
                  }}
                >
                  <option value="inspect">Inspect</option>
                  <option value="polygon">Mask points</option>
                  <option value="pivot">Joint pivot</option>
                  <option value="tip">Joint tip</option>
                  <option value="origin">Ground origin</option>
                </select>
              </label>
              {edit === "polygon" && (
                <div className="text-xs text-muted-foreground">
                  <p>
                    Drag points. Shift-click adds a point. Masks include the part behind foreground
                    layers.
                  </p>
                  <button
                    type="button"
                    className="mt-2 underline disabled:opacity-30"
                    disabled={part.polygon.length <= 3}
                    onClick={() => updatePart({ polygon: part.polygon.slice(0, -1) })}
                  >
                    Remove last point
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-3 text-xs">
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    const parts = [...session.plan.parts],
                      i = parts.findIndex((p) => p.id === selected);
                    if (i < parts.length - 1) {
                      [parts[i], parts[i + 1]] = [parts[i + 1], parts[i]];
                      commit({ ...session, plan: { ...session.plan, parts } });
                    }
                  }}
                >
                  Bring forward
                </button>
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    const parts = [...session.plan.parts],
                      i = parts.findIndex((p) => p.id === selected);
                    if (i > 0) {
                      [parts[i], parts[i - 1]] = [parts[i - 1], parts[i]];
                      commit({ ...session, plan: { ...session.plan, parts } });
                    }
                  }}
                >
                  Send back
                </button>
              </div>
              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showMasks}
                    onChange={(e) => setShowMasks(e.target.checked)}
                  />
                  Mask overlay
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showGenerated}
                    onChange={(e) => setShowGenerated(e.target.checked)}
                  />
                  Reconstructed pixels only
                </label>
              </div>
              <div className="border-t pt-3 text-xs text-muted-foreground">
                <p>{layer?.visiblePixels.toLocaleString() ?? 0} original pixels</p>
                <p>
                  {layer?.filledPixels.toLocaleString() ?? 0} /{" "}
                  {layer?.hiddenPixels.toLocaleString() ?? 0} hidden pixels filled
                </p>
                <button
                  type="button"
                  className="mt-2 underline"
                  onClick={() => completionRef.current?.click()}
                >
                  Import aligned completion PNG
                </button>
                {session.completions[selected] && (
                  <button
                    type="button"
                    className="mt-2 block underline"
                    onClick={() => {
                      const completions = { ...session.completions };
                      delete completions[selected];
                      commit({ ...session, completions });
                    }}
                  >
                    Discard completion
                  </button>
                )}
              </div>
              <label className="block text-xs text-muted-foreground">
                Completion guidance
                <textarea
                  className="mt-1 min-h-16 w-full rounded border bg-background p-2 text-xs text-foreground"
                  value={part.description}
                  onChange={(e) => updatePart({ description: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="text-xs text-destructive underline disabled:opacity-30"
                disabled={session.plan.parts.length < 2}
                onClick={removePart}
              >
                Remove part
              </button>
            </fieldset>
          )}
          <div className="border-t pt-4">
            <button
              type="button"
              className="flex w-full justify-between text-sm"
              aria-expanded={keyOpen}
              onClick={() => setKeyOpen(!keyOpen)}
            >
              AI preparation <span>{keyOpen ? "−" : "+"}</span>
            </button>
            {keyOpen && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  These actions send your character to xAI. Your key stays in page memory and goes
                  directly to xAI. Draft masks need review.
                </p>
                <label className="block text-xs">
                  xAI API key
                  <input
                    aria-label="xAI API key"
                    type="password"
                    autoComplete="off"
                    className="mt-1 w-full rounded border bg-background p-2"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>
                <label className="block text-xs">
                  Character guidance
                  <textarea
                    className="mt-1 w-full rounded border bg-background p-2"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={1000}
                  />
                </label>
                <Button
                  variant="outline"
                  className="w-full text-xs"
                  disabled={!session || !apiKey.trim() || !!busy}
                  onClick={() => void draft()}
                >
                  Send to xAI · Draft layers
                </Button>
                <p className="text-xs text-muted-foreground">
                  Planning reservation estimate $0.05; token-billed, not a billing cap. Completion:
                  $0.05 estimated per part at 1K/low. No automatic retries.
                </p>
                <Button
                  variant="outline"
                  className="w-full text-xs"
                  disabled={!part || !layer?.hiddenPixels || !apiKey.trim() || !!busy}
                  onClick={() => void complete()}
                >
                  Send selected part · Complete
                </Button>
              </div>
            )}
          </div>
          {session && (
            <div className="flex flex-wrap gap-3 border-t pt-3 text-xs">
              <button
                type="button"
                disabled={!!busy}
                className="underline"
                onClick={() => planRef.current?.click()}
              >
                Import plan
              </button>
              <button
                type="button"
                className="underline"
                disabled={!!busy}
                onClick={() => {
                  setPlanJson(JSON.stringify(session.plan, null, 2));
                  setPlanOpen(!planOpen);
                }}
              >
                Edit plan JSON
              </button>
              <button
                type="button"
                className="underline"
                onClick={() =>
                  download(
                    "plan.json",
                    new Blob([JSON.stringify(session.plan, null, 2)], { type: "application/json" }),
                  )
                }
              >
                Save plan
              </button>
              <button
                type="button"
                className="underline"
                onClick={() =>
                  download(
                    "character.json",
                    new Blob([JSON.stringify(characterManifest(bundle!), null, 2)], {
                      type: "application/json",
                    }),
                  )
                }
              >
                Save manifest
              </button>
            </div>
          )}
        </aside>
      </div>
      {planOpen && (
        <section className="mt-5 border-y py-4">
          <label className="block text-sm font-medium">
            Layer plan JSON
            <textarea
              aria-label="Layer plan JSON"
              className="mt-2 h-72 w-full rounded border bg-background p-3 font-mono text-xs"
              value={planJson}
              maxLength={1024 * 1024}
              onChange={(e) => setPlanJson(e.target.value)}
            />
          </label>
          <p className="my-2 text-xs text-muted-foreground">
            Applying a plan replaces masks and joints and clears completion images. Undo restores
            the previous plan.
          </p>
          <div className="flex gap-3">
            <Button disabled={!!busy} onClick={() => act(async () => applyPlan(planJson))}>
              Apply plan
            </Button>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      <div className="mt-4 space-y-2 text-xs text-muted-foreground" aria-live="polite">
        {busy ? (
          <p>
            {busy}{" "}
            {controller.current && (
              <button
                type="button"
                className="underline"
                onClick={() => controller.current?.abort()}
              >
                Stop request
              </button>
            )}
          </p>
        ) : (
          <p>
            {status ||
              "Drafts are saved locally. Export the ZIP to keep source art, masks, joints and accepted completion pixels together."}
          </p>
        )}
        {[...new Set(bundle?.report.warnings)].map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </main>
  );
}
