"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TutorialStep } from "@/components/tutorial-strip";

interface UseTutorialOptions {
  /** Stable identifier — used as the localStorage key for dismissal. */
  id: string;
  /** The same step array passed to <TutorialStrip>. `done` flags drive auto-advance. */
  steps: TutorialStep[];
  /** Hide the strip entirely (skip first-visit auto-open) when this is true. */
  forceClosed?: boolean;
}

const KEY_PREFIX = "sprite-tools:tutorial:";

function readDismissed(id: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${KEY_PREFIX}${id}:dismissed`) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${id}:dismissed`, "1");
  } catch {
    // ignore quota / privacy-mode failures
  }
}

function hasTutorialParam(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(window.location.href).searchParams.get("tutorial") === "1";
  } catch {
    return false;
  }
}

function clearTutorialParam(): void {
  if (typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("tutorial")) return;
    u.searchParams.delete("tutorial");
    window.history.replaceState({}, "", u.toString());
  } catch {
    // ignore
  }
}

/**
 * State + behavior for the <TutorialStrip>.
 *
 * - Open by default unless localStorage has recorded a dismissal for this id.
 *   `?tutorial=1` in the URL forces open (overrides the dismissed flag).
 * - `currentStep` defaults to the first not-done step; auto-advances when the
 *   focused step's `done` flag flips true. Prev/Next overrides clamp manually.
 * - Dismissal writes localStorage and removes the URL param.
 */
export function useTutorial({ id, steps, forceClosed = false }: UseTutorialOptions) {
  // SSR: start closed and hydrate after mount to avoid mismatch.
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStepState] = useState(0);
  const hasHydrated = useRef(false);

  useEffect(() => {
    if (hasHydrated.current) return;
    hasHydrated.current = true;
    if (forceClosed) return;
    const forced = hasTutorialParam();
    const dismissed = readDismissed(id);
    setIsOpen(forced || !dismissed);
    // Don't seek to "first not-done" here — the auto-advance effect below
    // will cascade past any already-done leading steps once isOpen flips true.
  }, [id, forceClosed]);

  // Auto-advance: when the focused step becomes done, move to the next one.
  const focusedDone = steps[currentStep]?.done ?? false;
  useEffect(() => {
    if (!isOpen) return;
    if (!focusedDone) return;
    if (currentStep >= steps.length - 1) return;
    setCurrentStepState((s) => Math.min(s + 1, steps.length - 1));
  }, [focusedDone, currentStep, isOpen, steps.length]);

  const dismiss = useCallback(() => {
    setIsOpen(false);
    writeDismissed(id);
    clearTutorialParam();
  }, [id]);

  const goNext = useCallback(() => {
    setCurrentStepState((s) => Math.min(s + 1, steps.length - 1));
  }, [steps.length]);

  const goPrev = useCallback(() => {
    setCurrentStepState((s) => Math.max(s - 1, 0));
  }, []);

  const setCurrentStep = useCallback(
    (i: number) => {
      setCurrentStepState(Math.min(Math.max(0, i), steps.length - 1));
    },
    [steps.length],
  );

  return {
    isOpen,
    currentStep,
    dismiss,
    goNext,
    goPrev,
    setCurrentStep,
  } as const;
}
