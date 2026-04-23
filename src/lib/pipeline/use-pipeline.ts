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

function reducer(state: PipelineState, action: Action): PipelineState {
  switch (action.type) {
    case "set-source": {
      // New source clears history.
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
// The hook itself
// -----------------------------------------------------------------

export function usePipeline() {
  const [state, dispatch] = React.useReducer(reducer, initial);
  const lastOutputRef = React.useRef<Frames | null>(null);
  const runTokenRef = React.useRef(0);

  // Run the pipeline whenever source or steps change.
  React.useEffect(() => {
    const token = ++runTokenRef.current;
    (async () => {
      if (!state.source) {
        dispatch({ type: "set-output", output: null });
        return;
      }
      dispatch({ type: "set-running", running: true });
      dispatch({ type: "set-error", error: null });
      try {
        let current: Frames | null = null;
        for (const step of state.steps) {
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
              current = result.value;
              break;
            }
            case "import-sheet": {
              if (!state.source.file && !state.source.url) throw new Error("No sheet source");
              current = await importFromSpriteSheet(
                state.source.file ?? state.source.url!,
                step.config,
              );
              break;
            }
            case "import-files": {
              if (!state.source.images) throw new Error("No images source");
              current = await importFromFiles(state.source.images);
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
              current = r.value;
              break;
            }
            case "auto-crop": {
              if (!current) throw new Error("Auto-crop needs import step first");
              current = await runAutoCrop(current, step.config);
              break;
            }
            case "manual-crop": {
              if (!current) throw new Error("Manual crop needs import step first");
              current = await runManualCrop(current, step.config.crop);
              break;
            }
            case "select": {
              if (!current) throw new Error("Select needs import step first");
              current = selectFrames(current, step.config.indices);
              break;
            }
          }
        }
        if (runTokenRef.current !== token) return;
        // Dispose previous output's bitmaps since we're replacing them.
        if (lastOutputRef.current) disposeFrames(lastOutputRef.current);
        lastOutputRef.current = current;
        dispatch({ type: "set-output", output: current });
      } catch (e) {
        if (runTokenRef.current !== token) return;
        dispatch({ type: "set-error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (runTokenRef.current === token) {
          dispatch({ type: "set-running", running: false });
          dispatch({ type: "set-progress", progress: null });
        }
      }
    })();
  }, [state.source, state.steps]);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      if (lastOutputRef.current) disposeFrames(lastOutputRef.current);
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
