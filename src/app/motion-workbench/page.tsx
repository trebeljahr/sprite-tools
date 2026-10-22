"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { importCharacterZip, sessionStore, type CharacterSession } from "@/lib/character/browser";
import { prepareCharacter, poseTransforms } from "@/lib/character/core";
import { validatePlan } from "@/lib/character/types";
import { linkedCharacterProject } from "@/lib/character/linked-project";
import {
  autoBind,
  clipSchema,
  evaluateMotion,
  projectSchema,
  retargetPose,
  ROLES,
  sampleClip,
  transformPoint,
  type JointRole,
  type MotionClip,
  type MotionProject,
} from "@/lib/motion/core";
import { motionMannequin, newMotionProject } from "@/lib/motion/presets";
import {
  bakeMotion,
  characterArtwork,
  drawMotion,
  exportMotionProject,
  importMotionProject,
  motionStore,
} from "@/lib/motion/browser";

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function Slider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  text,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  text?: string;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="flex justify-between gap-3">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{text ?? value.toFixed(2)}</span>
      </span>
      <input
        className="w-full accent-teal-600"
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export default function MotionWorkbench() {
  const [session, setSession] = useState<CharacterSession | null>(null),
    [project, setProject] = useState<MotionProject | null>(null),
    [name, setName] = useState("Balanced mannequin");
  const [phase, setPhase] = useState(0),
    [playing, setPlaying] = useState(true),
    [actionPhase, setActionPhase] = useState<number | undefined>(),
    [role, setRole] = useState<JointRole>("front-arm");
  const [clipped, setClipped] = useState(false);
  const [showRig, setShowRig] = useState(true),
    [showArt, setShowArt] = useState(true),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [keyIndex, setKeyIndex] = useState(0);
  const [undo, setUndo] = useState<MotionProject[]>([]),
    [redo, setRedo] = useState<MotionProject[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null),
    characterFile = useRef<HTMLInputElement>(null),
    projectFile = useRef<HTMLInputElement>(null),
    motionFile = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  useEffect(() => {
    let alive = true;
    const ac = new AbortController(),
      rev = revision.current;
    void (async () => {
      let saved: Awaited<ReturnType<typeof motionStore>> = null;
      try {
        saved = await motionStore();
      } catch {
        if (alive) setStatus("Local storage unavailable. Save a project ZIP before closing.");
      }
      let next = saved?.session ?? motionMannequin(),
        p = saved ? projectSchema.parse(saved.project) : newMotionProject(next.plan),
        n = saved?.name ?? "Balanced mannequin";
      const path = new URLSearchParams(location.search).get("project");
      if (path) {
        next = await linkedCharacterProject(path, location.href, ac.signal);
        p = { ...p, binding: autoBind(next.plan) };
        n = "Linked character";
      }
      if (new URLSearchParams(location.search).get("draft") === "layers") {
        const layerDraft = await sessionStore();
        if (!layerDraft) throw Error("No Character Layers draft found.");
        next = layerDraft;
        p = { ...p, binding: autoBind(next.plan) };
        n = "Character Layers draft";
      }
      validatePlan(next.plan);
      if (alive && revision.current === rev) {
        setSession(next);
        setProject(p);
        setName(n);
        setReady(true);
      }
    })().catch((e) => {
      if (alive) {
        const next = motionMannequin();
        setSession(next);
        setProject(newMotionProject(next.plan));
        setReady(true);
        setError(String(e instanceof Error ? e.message : e));
      }
    });
    return () => {
      alive = false;
      ac.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready || !project || !session) return;
    const timer = setTimeout(() => {
      void motionStore({ project, session, name }).catch(() =>
        setStatus("Draft could not be saved. Download a project ZIP to keep it."),
      );
    }, 500);
    return () => clearTimeout(timer);
  }, [ready, project, session, name]);
  const bundle = useMemo(
    () =>
      session
        ? prepareCharacter(
            session.source,
            session.plan,
            session.completions,
            session.completionKinds ?? {},
          )
        : null,
    [session],
  );
  const artwork = useMemo(() => (bundle ? characterArtwork(bundle) : null), [bundle]);
  const evaluated = useMemo(
    () => (project ? evaluateMotion(project, phase, actionPhase) : null),
    [project, phase, actionPhase],
  );
  const result = useMemo(
    () =>
      project && bundle && evaluated
        ? retargetPose(bundle.plan, project.binding, evaluated.pose, project.settings.footTargets)
        : null,
    [project, bundle, evaluated],
  );
  const selectedClip = project?.clips.find((c) => c.id === project.settings.selected),
    selectedKey = selectedClip?.frames[Math.min(keyIndex, selectedClip.frames.length - 1)];
  const commit = (next: MotionProject) => {
    setUndo((prev) => [...prev.slice(-24), project!]);
    setRedo([]);
    setProject(projectSchema.parse(next));
  };
  const setting = (patch: Partial<MotionProject["settings"]>) => {
    if (project) setProject({ ...project, settings: { ...project.settings, ...patch } });
  };
  const applyCharacter = (next: CharacterSession, label: string) => {
    revision.current++;
    setSession(next);
    setName(label);
    setUndo([]);
    setRedo([]);
    setPhase(0);
    setActionPhase(undefined);
    setProject((p) => (p ? { ...p, binding: autoBind(next.plan) } : newMotionProject(next.plan)));
    setError("");
    setStatus("Motion library kept. Review joint mapping and target reach for this character.");
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!playing || !project || busy) return;
    let request = 0,
      previous = 0;
    const loop =
      project.settings.mode === "locomotion" ||
      !!project.clips.find((c) => c.id === project.settings.selected)?.loop;
    const duration = evaluateMotion(project, 0).duration,
      actionDuration =
        project.clips.find((c) => c.id === project.settings.action)!.duration /
        project.settings.rate;
    const tick = (now: number) => {
      const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
      previous = now;
      setPhase((p) => (loop ? (p + dt / duration) % 1 : Math.min(1, p + dt / duration)));
      setActionPhase((p) =>
        p === undefined
          ? undefined
          : p + dt / actionDuration >= 1
            ? undefined
            : p + dt / actionDuration,
      );
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, project, busy]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest("input, select, textarea, button, a") ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.code === "KeyF" && !e.repeat) {
        setActionPhase(0);
        setPlaying(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !bundle || !artwork || !project || !evaluated) return;
    const pad = project.settings.padding,
      w = bundle.plan.width + pad * 2,
      h = bundle.plan.height + pad * 2;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#142225";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#223438";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(pad, pad);
    ctx.strokeStyle = "#62847e";
    ctx.beginPath();
    ctx.moveTo(-pad, bundle.plan.origin.y);
    ctx.lineTo(bundle.plan.width + pad, bundle.plan.origin.y);
    ctx.stroke();
    const r = showArt
      ? drawMotion(ctx, bundle, artwork, project, evaluated.pose)
      : {
          ...retargetPose(
            bundle.plan,
            project.binding,
            evaluated.pose,
            project.settings.footTargets,
          ),
          matrices: null,
        };
    setClipped("clipped" in r ? r.clipped : false);
    if (showRig) {
      const matrices = r.matrices ?? poseTransforms(bundle.plan, r.angles);
      ctx.save();
      ctx.translate(r.root.x, r.root.y);
      for (const [joint, binding] of Object.entries(project.binding)) {
        const part = bundle.plan.parts.find((p) => p.id === binding!.part);
        if (!part) continue;
        const m = matrices[part.id],
          a = transformPoint(m, part.pivot),
          b = transformPoint(m, part.tip);
        ctx.strokeStyle = joint === role ? "#f6c66c" : "#7ee1cf";
        ctx.lineWidth = joint === role ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.fillStyle = joint === role ? "#f6c66c" : "#b5e5dc";
        ctx.beginPath();
        ctx.arc(a.x, a.y, joint === role ? 5 : 3, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
    }
    for (const side of ["front", "rear"] as const) {
      if (!evaluated.pose.contacts.includes(side)) continue;
      const p = evaluated.pose.feet[side];
      if (!p) continue;
      const x = bundle.plan.origin.x + p.x * r.unit;
      ctx.fillStyle = "#7ee1cf";
      ctx.fillRect(x - 9, bundle.plan.origin.y + 4, 18, 3);
    }
    ctx.restore();
  }, [project, bundle, artwork, evaluated, showRig, showArt, role]);
  useEffect(() => {
    if (
      project?.settings.mode === "clip" &&
      !selectedClip?.loop &&
      phase >= 1 &&
      actionPhase === undefined
    )
      setPlaying(false);
  }, [phase, actionPhase, project?.settings.mode, selectedClip?.loop]);
  const updateClip = (next: MotionClip) => {
    if (project)
      commit({
        ...project,
        clips: project.clips.map((c) => (c.id === next.id ? clipSchema.parse(next) : c)),
      });
  };
  const updateKey = (patch: Partial<NonNullable<typeof selectedKey>>) => {
    if (selectedClip && selectedKey)
      updateClip({
        ...selectedClip,
        frames: selectedClip.frames.map((f, i) => (i === keyIndex ? { ...f, ...patch } : f)),
      });
  };
  const inspectKey = (index: number) => {
    setKeyIndex(index);
    setPlaying(false);
    setActionPhase(undefined);
    if (selectedClip) {
      setPhase(selectedClip.frames[index].t);
      setting({ mode: "clip" });
    }
  };
  const changeMapping = (part: string) => {
    if (!project) return;
    if (part && Object.entries(project.binding).some(([r, b]) => r !== role && b?.part === part)) {
      setError("That part already has a role. Unmap it before assigning another role.");
      return;
    }
    const binding = { ...project.binding };
    if (part) binding[role] = { part, offset: 0 };
    else delete binding[role];
    commit({ ...project, binding });
    setError("");
  };
  const bake = (action: boolean) =>
    act(async () => {
      if (!project || !bundle) return;
      download(
        action ? "action-sprites.zip" : "motion-sprites.zip",
        await bakeMotion(project, bundle, action, setStatus),
      );
      setStatus("Sprite sheet, sampled poses, contacts and events exported.");
    });
  if (
    !ready ||
    !project ||
    !bundle ||
    !session ||
    !evaluated ||
    !result ||
    !selectedClip ||
    !selectedKey
  )
    return <main className="p-8 text-sm text-muted-foreground">Loading motion workbench…</main>;
  const unmapped = [
    "torso",
    "front-thigh",
    "front-shin",
    "front-foot",
    "rear-thigh",
    "rear-shin",
    "rear-foot",
  ].filter((r) => !project.binding[r as JointRole]);
  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6 lg:px-7">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.17em] text-muted-foreground">
            Character motion
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Motion Workbench</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Adapt a motion, blend poses, and bake sprite frames.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => projectFile.current?.click()}>
            Open project
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(async () => {
                download(
                  "character-motion.zip",
                  await exportMotionProject(project, session, bundle),
                );
                setStatus("Project saved with artwork, mapping and editable motion clips.");
              })
            }
          >
            Save project
          </Button>
          <Button disabled={busy} onClick={() => bake(false)}>
            Export sprites
          </Button>
        </div>
      </header>
      <input
        hidden
        type="file"
        accept=".zip"
        ref={projectFile}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void act(async () => {
              const next = await importMotionProject(file);
              applyCharacter(next.session, file.name);
              setProject(next.project);
              setStatus("Motion project loaded.");
            });
        }}
      />
      <input
        hidden
        type="file"
        accept=".zip"
        ref={characterFile}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void act(async () => applyCharacter(await importCharacterZip(file), file.name));
        }}
      />
      <input
        hidden
        type="file"
        accept=".json"
        ref={motionFile}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void act(async () => {
              if (file.size > 1024 * 1024) throw Error("Motion JSON exceeds 1 MB.");
              const raw = JSON.parse(await file.text());
              const clip = clipSchema.parse(
                raw?.format === "sprite-tools-motion-study" ? raw.clip : raw,
              );
              const clips = project.clips.filter((c) => c.id !== clip.id);
              commit({
                ...project,
                clips: [...clips, clip],
                settings: { ...project.settings, selected: clip.id, mode: "clip" },
              });
              setPhase(0);
              setKeyIndex(0);
              setStatus("Motion clip imported. Artwork and mapping kept.");
            });
        }}
      />
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid items-start gap-0 border-y xl:grid-cols-[250px_minmax(0,1fr)_290px]">
        <aside className="space-y-6 py-5 xl:pr-5">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Character</h2>
            <p className="truncate text-xs text-muted-foreground" title={name}>
              {name}
            </p>
            <label className="block text-xs text-muted-foreground">
              Motion mannequin
              <select
                aria-label="Motion mannequin"
                className={`${field} mt-1`}
                value={
                  name === "Balanced mannequin"
                    ? "balanced"
                    : name === "Compact mannequin"
                      ? "compact"
                      : name === "Long-legged mannequin"
                        ? "long-legged"
                        : ""
                }
                onChange={(e) =>
                  applyCharacter(
                    motionMannequin(e.target.value as "balanced" | "compact" | "long-legged"),
                    `${e.target.selectedOptions[0].text} mannequin`,
                  )
                }
              >
                <option value="" disabled>
                  Choose proportions
                </option>
                <option value="balanced">Balanced</option>
                <option value="compact">Compact</option>
                <option value="long-legged">Long-legged</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => characterFile.current?.click()}
              >
                Import character
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const saved = await sessionStore();
                    if (!saved)
                      throw Error(
                        "No layer draft found. Open Character Layers and import your artwork first.",
                      );
                    applyCharacter(saved, "Character Layers draft");
                  })
                }
              >
                Use layer draft
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Import a Character Layers ZIP. Joint mapping adapts these motions to its proportions.
            </p>
            <Link className="text-xs underline underline-offset-4" href="/character-layers">
              Open Character Layers →
            </Link>
          </section>
          <section className="space-y-4 border-t pt-5">
            <h2 className="text-sm font-semibold">Motion</h2>
            <label className="block text-xs text-muted-foreground">
              Preview
              <select
                aria-label="Preview mode"
                className={`${field} mt-1`}
                value={project.settings.mode}
                onChange={(e) => {
                  setting({ mode: e.target.value as "locomotion" | "clip" });
                  setPhase(0);
                  setActionPhase(undefined);
                }}
              >
                <option value="locomotion">Walk ↔ Run blend</option>
                <option value="clip">Single clip</option>
              </select>
            </label>
            {project.settings.mode === "locomotion" ? (
              <Slider
                label="Walk / run blend"
                value={project.settings.speed}
                onChange={(v) => setting({ speed: v })}
                text={`${Math.round((1 - project.settings.speed) * 100)}% walk · ${Math.round(project.settings.speed * 100)}% run`}
              />
            ) : (
              <label className="block text-xs text-muted-foreground">
                Clip
                <select
                  aria-label="Motion clip"
                  className={`${field} mt-1`}
                  value={project.settings.selected}
                  onChange={(e) => {
                    setting({ selected: e.target.value });
                    setPhase(0);
                    setKeyIndex(0);
                    setActionPhase(undefined);
                  }}
                >
                  {project.clips.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Slider
              label="Playback rate"
              value={project.settings.rate}
              min={0.1}
              max={2}
              onChange={(v) => setting({ rate: v })}
              text={`${project.settings.rate.toFixed(2)}×`}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={project.settings.footTargets}
                onChange={(e) => setting({ footTargets: e.target.checked })}
              />
              Solve foot targets
            </label>
            <p className="text-xs text-muted-foreground">
              {evaluated.duration.toFixed(2)} s / cycle ·{" "}
              {(evaluated.stride / evaluated.duration).toFixed(2)} leg lengths / s
            </p>
          </section>
          <section className="space-y-4 border-t pt-5">
            <h2 className="text-sm font-semibold">Action / transition</h2>
            <select
              aria-label="Action clip"
              className={field}
              value={project.settings.action}
              onChange={(e) => {
                setting({ action: e.target.value });
                setActionPhase(undefined);
              }}
            >
              {project.clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label className="block text-xs text-muted-foreground">
              Affected joints
              <select
                aria-label="Action mask"
                className={`${field} mt-1`}
                value={project.settings.actionMask}
                onChange={(e) => setting({ actionMask: e.target.value as "full" | "upper" })}
              >
                <option value="full">Full body</option>
                <option value="upper">Upper body</option>
              </select>
            </label>
            <Slider
              label="Action weight"
              value={project.settings.actionWeight}
              onChange={(v) => setting({ actionWeight: v })}
            />
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                setActionPhase(0);
                setPlaying(true);
              }}
            >
              Play action · F
            </Button>
            <Slider
              label="Action phase"
              value={actionPhase ?? 0}
              onChange={(v) => {
                setPlaying(false);
                setActionPhase(v);
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => setActionPhase(undefined)}>
              Clear action
            </Button>
          </section>
        </aside>
        <section className="min-w-0 border-y xl:border-x xl:border-y-0">
          <div className="flex flex-wrap justify-between gap-3 border-b px-4 py-3 text-xs">
            <span className="font-mono">BIPED · SIDE VIEW</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showArt}
                  onChange={(e) => setShowArt(e.target.checked)}
                />
                Artwork
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showRig}
                  onChange={(e) => setShowRig(e.target.checked)}
                />
                Joints
              </label>
            </div>
          </div>
          <div className="flex min-h-[360px] items-center justify-center overflow-hidden bg-[#142225] px-2">
            <canvas
              ref={canvas}
              aria-label="Character motion preview"
              className="block max-h-[610px] w-full object-contain"
            />
          </div>
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!playing && phase >= 1) setPhase(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPhase(0);
                  setActionPhase(undefined);
                }}
              >
                Reset
              </Button>
              <span className="ml-auto font-mono text-xs text-muted-foreground" aria-live="off">
                Phase {phase.toFixed(2)}
                {actionPhase !== undefined ? ` · Action ${actionPhase.toFixed(2)}` : ""}
              </span>
            </div>
            <Slider
              label="Cycle phase"
              value={phase}
              onChange={(v) => {
                setPlaying(false);
                setPhase(v);
              }}
              text={`${Math.round(phase * 100)}%`}
            />
            <div className="flex flex-wrap gap-2 text-xs">
              {project.clips
                .find(
                  (c) =>
                    c.id ===
                    (actionPhase === undefined
                      ? project.settings.selected
                      : project.settings.action),
                )
                ?.events.map((e) => (
                  <button
                    type="button"
                    className="rounded border px-2 py-1 hover:bg-muted"
                    key={`${e.t}-${e.name}`}
                    onClick={() => {
                      setPlaying(false);
                      if (actionPhase !== undefined) setActionPhase(e.t);
                      else {
                        setting({ mode: "clip" });
                        setPhase(e.t);
                      }
                    }}
                  >
                    {e.name} · {e.t.toFixed(2)}
                  </button>
                ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Joint poses blend before artwork is drawn. Foot targets describe an in-place cycle;
              game movement stays separate.
            </p>
          </div>
          {(clipped ||
            unmapped.length > 0 ||
            result.warnings.length > 0 ||
            bundle.report.unassignedPixels > 0 ||
            bundle.layers.some((l) => l.filledPixels < l.hiddenPixels)) && (
            <div className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-1 font-semibold text-foreground">Character review</p>
              {clipped && (
                <p>Artwork reaches the canvas edge. Increase export padding or adjust this pose.</p>
              )}
              {unmapped.length > 0 && <p>Unmapped: {unmapped.join(", ")}.</p>}
              {result.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              {bundle.report.unassignedPixels > 0 && (
                <p>
                  {bundle.report.unassignedPixels} unassigned pixels remain in their source
                  position.
                </p>
              )}
              {bundle.layers.some((l) => l.filledPixels < l.hiddenPixels) && (
                <p>Hidden artwork is incomplete. Check the layer editor for gaps.</p>
              )}
            </div>
          )}
        </section>
        <aside className="space-y-5 py-5 xl:pl-5">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Joint mapping</h2>
            <select
              aria-label="Joint role"
              className={field}
              value={role}
              onChange={(e) => setRole(e.target.value as JointRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll("-", " ")}
                </option>
              ))}
            </select>
            <label className="block text-xs text-muted-foreground">
              Artwork part
              <select
                aria-label="Artwork part"
                className={`${field} mt-1`}
                value={project.binding[role]?.part ?? ""}
                onChange={(e) => changeMapping(e.target.value)}
              >
                <option value="">Unmapped</option>
                {session.plan.parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {project.binding[role] && (
              <Slider
                label="Neutral angle offset"
                value={project.binding[role]!.offset}
                min={-180}
                max={180}
                step={1}
                text={`${project.binding[role]!.offset}°`}
                onChange={(v) =>
                  commit({
                    ...project,
                    binding: {
                      ...project.binding,
                      [role]: { ...project.binding[role]!, offset: v },
                    },
                  })
                }
              />
            )}
            <p className="text-xs text-muted-foreground">
              The weapon keeps its grip on the mapped hand through the artwork hierarchy.
            </p>
          </section>
          <section className="space-y-3 border-t pt-5">
            <h2 className="text-sm font-semibold">Edit motion keys</h2>
            <label className="block text-xs text-muted-foreground">
              Source clip
              <select
                aria-label="Edit source clip"
                className={`${field} mt-1`}
                value={selectedClip.id}
                onChange={(e) => {
                  setting({ selected: e.target.value, mode: "clip" });
                  setKeyIndex(0);
                  setPhase(0);
                  setPlaying(false);
                  setActionPhase(undefined);
                }}
              >
                {project.clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {selectedClip.frames.map((f, i) => (
                <button
                  type="button"
                  className={`rounded border px-2 py-1 font-mono text-xs ${i === keyIndex ? "border-teal-600 bg-teal-600/10" : "hover:bg-muted"}`}
                  key={f.t}
                  aria-label={`Keyframe ${i + 1}`}
                  aria-pressed={i === keyIndex}
                  onClick={() => inspectKey(i)}
                >
                  {f.t.toFixed(2)}
                </button>
              ))}
            </div>
            <Slider
              label="Joint rotation"
              min={-180}
              max={180}
              step={1}
              value={selectedKey.angles[role] ?? 0}
              text={`${Math.round(selectedKey.angles[role] ?? 0)}°`}
              onChange={(v) => {
                inspectKey(keyIndex);
                updateKey({ angles: { ...selectedKey.angles, [role]: v } });
              }}
            />
            <Slider
              label="Body horizontal offset"
              min={-0.5}
              max={0.5}
              value={selectedKey.root.x}
              onChange={(v) => {
                inspectKey(keyIndex);
                updateKey({ root: { ...selectedKey.root, x: v } });
              }}
            />
            <Slider
              label="Body height offset"
              min={-1.5}
              max={0.5}
              value={selectedKey.root.y}
              onChange={(v) => {
                inspectKey(keyIndex);
                updateKey({ root: { ...selectedKey.root, y: v } });
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">
                Duration (s)
                <input
                  aria-label="Clip duration"
                  className={`${field} mt-1`}
                  type="number"
                  min={0.15}
                  max={10}
                  step={0.05}
                  value={selectedClip.duration}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v >= 0.15 && v <= 10) updateClip({ ...selectedClip, duration: v });
                  }}
                />
              </label>
              <label className="flex items-center gap-2 self-end py-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedClip.loop}
                  onChange={(e) => updateClip({ ...selectedClip, loop: e.target.checked })}
                />
                Loop
              </label>
            </div>
            <details>
              <summary className="cursor-pointer text-xs">Foot targets & contacts</summary>
              <div className="mt-3 space-y-3">
                {(["front", "rear"] as const).map((side) => (
                  <div key={side} className="space-y-2">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={!!selectedKey.feet[side]}
                        onChange={(e) => {
                          inspectKey(keyIndex);
                          updateKey({
                            feet: {
                              ...selectedKey.feet,
                              [side]: e.target.checked
                                ? { x: side === "front" ? 0.12 : -0.12, y: 0 }
                                : undefined,
                            },
                          });
                        }}
                      />
                      {side} target
                    </label>
                    {selectedKey.feet[side] &&
                      (["x", "y"] as const).map((axis) => (
                        <Slider
                          key={axis}
                          label={`${side} foot ${axis}`}
                          min={-1}
                          max={1}
                          value={selectedKey.feet[side]![axis]}
                          onChange={(v) => {
                            inspectKey(keyIndex);
                            updateKey({
                              feet: {
                                ...selectedKey.feet,
                                [side]: { ...selectedKey.feet[side]!, [axis]: v },
                              },
                            });
                          }}
                        />
                      ))}
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedKey.contacts.includes(side)}
                        onChange={(e) =>
                          updateKey({
                            contacts: e.target.checked
                              ? [...selectedKey.contacts.filter((s) => s !== side), side]
                              : selectedKey.contacts.filter((s) => s !== side),
                          })
                        }
                      />
                      {side} contact
                    </label>
                  </div>
                ))}
              </div>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  selectedClip.frames.length >= 128 ||
                  selectedClip.frames.some((f) => Math.abs(f.t - phase) < 0.001)
                }
                onClick={() => {
                  const f = sampleClip(selectedClip, phase);
                  const frames = [...selectedClip.frames, { ...f, t: phase }].sort(
                    (a, b) => a.t - b.t,
                  );
                  updateClip({ ...selectedClip, frames });
                  setKeyIndex(frames.findIndex((f) => f.t === phase));
                }}
              >
                Add key here
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={keyIndex === 0 || keyIndex >= selectedClip.frames.length - 1}
                onClick={() => {
                  updateClip({
                    ...selectedClip,
                    frames: selectedClip.frames.filter((_, i) => i !== keyIndex),
                  });
                  setKeyIndex(0);
                  setPhase(0);
                }}
              >
                Remove key
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!undo.length}
                onClick={() => {
                  setRedo([...redo, project]);
                  setProject(undo.at(-1)!);
                  setUndo(undo.slice(0, -1));
                  setKeyIndex(0);
                }}
              >
                Undo
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!redo.length}
                onClick={() => {
                  setUndo([...undo, project]);
                  setProject(redo.at(-1)!);
                  setRedo(redo.slice(0, -1));
                  setKeyIndex(0);
                }}
              >
                Redo
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer text-xs">Events</summary>
              <div className="mt-2 space-y-2">
                {selectedClip.events.map((event, index) => (
                  // Event fields use positional identity so editing a name or phase keeps input focus.
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable editable rows; removal shifts subsequent rows intentionally
                  <div className="flex gap-1" key={index}>
                    <input
                      aria-label={`Event ${index + 1} name`}
                      className={`${field} min-w-0`}
                      value={event.name}
                      maxLength={60}
                      onChange={(e) => {
                        if (e.target.value.trim())
                          updateClip({
                            ...selectedClip,
                            events: selectedClip.events.map((v, i) =>
                              i === index ? { ...v, name: e.target.value } : v,
                            ),
                          });
                      }}
                    />
                    <input
                      aria-label={`Event ${index + 1} phase`}
                      className={`${field} w-20`}
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      value={event.t}
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        if (t >= 0 && t <= 1)
                          updateClip({
                            ...selectedClip,
                            events: selectedClip.events.map((v, i) =>
                              i === index ? { ...v, t } : v,
                            ),
                          });
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Remove event ${index + 1}`}
                      onClick={() =>
                        updateClip({
                          ...selectedClip,
                          events: selectedClip.events.filter((_, i) => i !== index),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={selectedClip.events.length >= 32}
                  onClick={() =>
                    updateClip({
                      ...selectedClip,
                      events: [...selectedClip.events, { t: phase, name: "event" }],
                    })
                  }
                >
                  Add event here
                </Button>
              </div>
            </details>
            <Button
              size="sm"
              variant="outline"
              disabled={project.clips.length >= 24}
              onClick={() => {
                let n = 2,
                  id = `${selectedClip.id.slice(0, 56)}-${n}`;
                while (project.clips.some((c) => c.id === id))
                  id = `${selectedClip.id.slice(0, 56)}-${++n}`;
                commit({
                  ...project,
                  clips: [
                    ...project.clips,
                    {
                      ...structuredClone(selectedClip),
                      id,
                      name: `${selectedClip.name.slice(0, 70)} copy`,
                    },
                  ],
                  settings: { ...project.settings, mode: "clip", selected: id },
                });
                setKeyIndex(0);
                setPhase(0);
                setActionPhase(undefined);
              }}
            >
              Duplicate clip
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => motionFile.current?.click()}>
                Import motion
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  download(
                    `${selectedClip.id}.motion.json`,
                    new Blob([JSON.stringify(selectedClip, null, 2)], { type: "application/json" }),
                  )
                }
              >
                Save motion
              </Button>
            </div>
          </section>
          <section className="space-y-3 border-t pt-5">
            <h2 className="text-sm font-semibold">Sprite export</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted-foreground">
                Frames / second
                <input
                  aria-label="Export FPS"
                  className={`${field} mt-1`}
                  type="number"
                  min={4}
                  max={30}
                  value={project.settings.fps}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 4 && n <= 30) setting({ fps: n });
                  }}
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Canvas padding
                <input
                  aria-label="Canvas padding"
                  className={`${field} mt-1`}
                  type="number"
                  min={0}
                  max={256}
                  value={project.settings.padding}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 0 && n <= 256) setting({ padding: n });
                  }}
                />
              </label>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => bake(true)}>
              Export moving action
            </Button>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Exports PNG + timing, contacts, events and weapon positions. Save the project to keep
              editable artwork.
            </p>
          </section>
        </aside>
      </div>
      <footer className="flex flex-wrap justify-between gap-3 py-4 text-xs text-muted-foreground">
        <p role="status">
          {status || "Draft stays in this browser. No provider calls or generation credits."}
        </p>
        <Link className="underline underline-offset-4" href="/docs/motion-workbench">
          Motion workflow guide →
        </Link>
      </footer>
    </main>
  );
}
