"use client";

import * as React from "react";
import { importFromFiles, importFromSpriteSheet, importFromVideo } from "./import";
import {
  autoCrop as runAutoCrop,
  chromaKey as runChromaKey,
  manualCrop as runManualCrop,
  selectFrames,
} from "./transforms";
import {
  disposeFrames,
  Frames,
  PipelineStep,
  Progress,
  type AutoCropConfig,
  type ChromaKeyConfig,
  type FrameCrop,
  type SheetSliceConfig,
  type VideoImportConfig,
} from "./types";

// A snapshot stores the step list that produced it. Frames are
// intentionally not retained past the latest snapshot; re-runs happen
// from the source import with the current step list.
interface Snapshot {
  steps: PipelineStep[];
}

interface PipelineState {
  source: { file?: File; url?: string; images?: File[] } | null;
  steps: PipelineStep[];
  output: Frames | null;
  running: boolean;
  progress: Progress | null;
  history: Snapshot[]; // past snapshots for undo
  future: Snapshot[]; // redo stack
  error: string | null;
}

type Action =
  | { type: "set-source"; payload: PipelineState["source"] }
  | { type: "set-steps"; payload: PipelineStep[]; record: boolean }
  | { type: "update-step"; stepId: string; config: PipelineStep["config"]; record: boolean }
  | { type: "remove-step"; stepId: string; record: boolean }
  | { type: "set-output"; output: Frames | null }
  | { type: "set-running"; running: boolean }
  | { type: "set-progress"; progress: Progress | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "set-error"; error: string | null }
  | { type: "reset" };

const MAX_HISTORY = 40;

function cloneSteps(s: PipelineStep[]): PipelineStep[] {
  return s.map((st) => ({ ...st, config: { ...st.config } }) as PipelineStep);
}

type SourceInput = PipelineState["source"];

function sourceEqual(a: SourceInput, b: SourceInput): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.file !== b.file || a.url !== b.url) return false;
  const ai = a.images, bi = b.images;
  if (ai === bi) return true;
  if (!ai || !bi || ai.length !== bi.length) return false;
  for (let i = 0; i < ai.length; i++) if (ai[i] !== bi[i]) return false;
  return true;
}

function reducer(state: PipelineState, action: Action): PipelineState {
  switch (action.type) {
    case "set-source": {
      // Idempotent: same source object means no reset (keeps the pipeline
      // output in place for re-runs that happen to pass the same source
      // twice, e.g. back-to-back clicks of Split Sheet).
      if (sourceEqual(state.source, action.payload)) return state;
      return {
        ...state,
        source: action.payload,
        steps: [],
        output: null,
        history: [],
        future: [],
        error: null,
      };
    }
    case "set-steps": {
      const next = cloneSteps(action.payload);
      return {
        ...state,
        steps: next,
        history: action.record
          ? [...state.history, { steps: cloneSteps(state.steps) }].slice(-MAX_HISTORY)
          : state.history,
        future: action.record ? [] : state.future,
      };
    }
    case "update-step": {
      const steps = cloneSteps(state.steps);
      const idx = steps.findIndex((s) => s.id === action.stepId);
      if (idx < 0) return state;
      steps[idx] = { ...steps[idx], config: action.config } as PipelineStep;
      return {
        ...state,
        steps,
        history: action.record
          ? [...state.history, { steps: cloneSteps(state.steps) }].slice(-MAX_HISTORY)
          : state.history,
        future: action.record ? [] : state.future,
      };
    }
    case "remove-step": {
      const before = cloneSteps(state.steps);
      const steps = state.steps.filter((s) => s.id !== action.stepId);
      return {
        ...state,
        steps,
        history: action.record
          ? [...state.history, { steps: before }].slice(-MAX_HISTORY)
          : state.history,
        future: action.record ? [] : state.future,
      };
    }
    case "set-output":
      return { ...state, output: action.output };
    case "set-running":
      return { ...state, running: action.running };
    case "set-progress":
      return { ...state, progress: action.progress };
    case "set-error":
      return { ...state, error: action.error };
    case "undo": {
      const prev = state.history[state.history.length - 1];
      if (!prev) return state;
      return {
        ...state,
        steps: prev.steps,
        history: state.history.slice(0, -1),
        future: [{ steps: cloneSteps(state.steps) }, ...state.future],
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        steps: next.steps,
        future: state.future.slice(1),
        history: [...state.history, { steps: cloneSteps(state.steps) }],
      };
    }
    case "reset":
      return {
        source: null,
        steps: [],
        output: null,
        running: false,
        progress: null,
        history: [],
        future: [],
        error: null,
      };
  }
}

const initial: PipelineState = {
  source: null,
  steps: [],
  output: null,
  running: false,
  progress: null,
  history: [],
  future: [],
  error: null,
};

let stepIdCounter = 0;
function nextStepId(): string {
  stepIdCounter += 1;
  return `s${stepIdCounter.toString(36)}`;
}

// Public helpers for building steps
export function buildChromaKeyStep(config: ChromaKeyConfig): PipelineStep {
  return { id: nextStepId(), kind: "chroma-key", config };
}
export function buildAutoCropStep(config: AutoCropConfig): PipelineStep {
  return { id: nextStepId(), kind: "auto-crop", config };
}
export function buildManualCropStep(crop: FrameCrop): PipelineStep {
  return { id: nextStepId(), kind: "manual-crop", config: { crop } };
}
export function buildSelectStep(indices: number[]): PipelineStep {
  return { id: nextStepId(), kind: "select", config: { indices } };
}
export function buildImportVideoStep(config: VideoImportConfig, sourceName?: string): PipelineStep {
  return { id: nextStepId(), kind: "import-video", config: { ...config, sourceName } };
}
export function buildImportSheetStep(config: SheetSliceConfig, sourceName?: string): PipelineStep {
  return { id: nextStepId(), kind: "import-sheet", config: { ...config, sourceName } };
}
export function buildImportFilesStep(count: number, sourceName?: string): PipelineStep {
  return { id: nextStepId(), kind: "import-files", config: { count, sourceName } };
}

// -----------------------------------------------------------------
// Step-level cache
// -----------------------------------------------------------------
// Each step's output is cached by (configKey, inputRef). On re-run, if
// both match we reuse the cached bitmap instead of re-running the step.
// This is the whole reason passthrough transforms clone their input —
// every cache entry's bitmaps are unique, so disposing one entry on
// replacement never takes out another entry's frames.

interface CacheEntry {
  configKey: string;
  inputRef: unknown;
  output: Frames;
}

function isImportStep(kind: PipelineStep["kind"]): boolean {
  return (
    kind === "import-video" || kind === "import-sheet" || kind === "import-files"
  );
}

// -----------------------------------------------------------------
// The hook itself
// -----------------------------------------------------------------

export function usePipeline() {
  const [state, dispatch] = React.useReducer(reducer, initial);
  const runTokenRef = React.useRef(0);
  const cacheRef = React.useRef<Map<string, CacheEntry>>(new Map());
  const cachedSourceRef = React.useRef<PipelineState["source"]>(null);

  // Run the pipeline whenever source or steps change.
  React.useEffect(() => {
    const token = ++runTokenRef.current;
    // If the source itself changed, drop the whole cache — any cached
    // import output depended on the old source and will never match again.
    if (state.source !== cachedSourceRef.current) {
      for (const entry of cacheRef.current.values()) disposeFrames(entry.output);
      cacheRef.current.clear();
      cachedSourceRef.current = state.source;
    }
    (async () => {
      if (!state.source) {
        dispatch({ type: "set-output", output: null });
        return;
      }
      if (state.steps.length === 0) {
        dispatch({ type: "set-output", output: null });
        return;
      }
      dispatch({ type: "set-running", running: true });
      dispatch({ type: "set-error", error: null });

      // Outputs we'll dispose after React has rendered with the new state.
      // Doing it inline risks flashing broken <img> tags during the
      // microtask window before the next render commits.
      const toDispose: Frames[] = [];

      try {
        let current: Frames | null = null;
        const visited = new Set<string>();

        for (const step of state.steps) {
          visited.add(step.id);
          const configKey = JSON.stringify(step.config);
          const inputRef: unknown = isImportStep(step.kind)
            ? state.source
            : current;
          const cached = cacheRef.current.get(step.id);
          if (
            cached &&
            cached.configKey === configKey &&
            cached.inputRef === inputRef
          ) {
            current = cached.output;
            continue;
          }

          let produced: Frames;
          switch (step.kind) {
            case "import-video": {
              const src = state.source.file ?? state.source.url!;
              const gen = importFromVideo(src, step.config);
              let result = await gen.next();
              while (!result.done) {
                if (runTokenRef.current !== token) return;
                dispatch({ type: "set-progress", progress: result.value });
                result = await gen.next();
              }
              produced = result.value;
              break;
            }
            case "import-sheet": {
              if (!state.source.file && !state.source.url)
                throw new Error("No sheet source");
              produced = await importFromSpriteSheet(
                state.source.file ?? state.source.url!,
                step.config,
              );
              break;
            }
            case "import-files": {
              if (!state.source.images) throw new Error("No images source");
              produced = await importFromFiles(state.source.images);
              break;
            }
            case "chroma-key": {
              if (!current) throw new Error("Chroma-key needs import step first");
              const gen = runChromaKey(current, step.config);
              let r = await gen.next();
              while (!r.done) {
                if (runTokenRef.current !== token) return;
                dispatch({ type: "set-progress", progress: r.value });
                r = await gen.next();
              }
              produced = r.value;
              break;
            }
            case "auto-crop": {
              if (!current) throw new Error("Auto-crop needs import step first");
              produced = await runAutoCrop(current, step.config);
              break;
            }
            case "manual-crop": {
              if (!current) throw new Error("Manual crop needs import step first");
              produced = await runManualCrop(current, step.config.crop);
              break;
            }
            case "select": {
              if (!current) throw new Error("Select needs import step first");
              produced = selectFrames(current, step.config.indices);
              break;
            }
          }

          if (runTokenRef.current !== token) {
            // Superseded by a newer run. The bitmaps we just produced
            // aren't cached yet, so dispose them here.
            toDispose.push(produced);
            return;
          }

          if (cached) toDispose.push(cached.output);
          cacheRef.current.set(step.id, {
            configKey,
            inputRef,
            output: produced,
          });
          current = produced;
        }

        // Drop cache entries for steps that are no longer in the pipeline.
        for (const [id, entry] of Array.from(cacheRef.current.entries())) {
          if (!visited.has(id)) {
            toDispose.push(entry.output);
            cacheRef.current.delete(id);
          }
        }

        if (runTokenRef.current !== token) return;
        dispatch({ type: "set-output", output: current });

        // Defer disposal so React has a chance to commit the new output
        // before the old bitmaps get revoked.
        if (toDispose.length > 0) {
          setTimeout(() => {
            for (const f of toDispose) disposeFrames(f);
          }, 60);
        }
      } catch (e) {
        if (runTokenRef.current !== token) return;
        dispatch({ type: "set-error", error: e instanceof Error ? e.message : String(e) });
        for (const f of toDispose) disposeFrames(f);
      } finally {
        if (runTokenRef.current === token) {
          dispatch({ type: "set-running", running: false });
          dispatch({ type: "set-progress", progress: null });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.source, state.steps]);

  // Cleanup on unmount: dispose everything we're holding onto.
  React.useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const entry of cache.values()) disposeFrames(entry.output);
      cache.clear();
    };
  }, []);

  return {
    state,
    setSource: (source: PipelineState["source"]) =>
      dispatch({ type: "set-source", payload: source }),
    setSteps: (steps: PipelineStep[], record = true) =>
      dispatch({ type: "set-steps", payload: steps, record }),
    updateStep: (stepId: string, config: PipelineStep["config"], record = true) =>
      dispatch({ type: "update-step", stepId, config, record }),
    removeStep: (stepId: string, record = true) =>
      dispatch({ type: "remove-step", stepId, record }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: state.history.length > 0,
    canRedo: state.future.length > 0,
    reset: () => dispatch({ type: "reset" }),
  };
}

export type UsePipelineReturn = ReturnType<typeof usePipeline>;
