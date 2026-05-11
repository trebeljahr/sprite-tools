"use client";

import { ChevronLeft, ChevronRight, Check, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TutorialStep {
  label: string;
  hint?: string;
  done: boolean;
}

interface TutorialStripProps {
  open: boolean;
  steps: TutorialStep[];
  /** Index of the step whose hint is shown (focused). */
  currentStep: number;
  title?: string;
  onDismiss: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Allow clicking on a step pill to jump to it. */
  onStepClick?: (index: number) => void;
  className?: string;
}

export function TutorialStrip({
  open,
  steps,
  currentStep,
  title = "Quickstart",
  onDismiss,
  onPrev,
  onNext,
  onStepClick,
  className,
}: TutorialStripProps) {
  if (!open) return null;
  const safeIdx = Math.min(Math.max(0, currentStep), steps.length - 1);
  const active = steps[safeIdx];
  const allDone = steps.every((s) => s.done);
  const canPrev = safeIdx > 0;
  const canNext = safeIdx < steps.length - 1;

  return (
    <div
      className={cn(
        "rounded-lg border bg-muted/30 px-4 py-3 mb-6 flex items-start gap-3",
        className,
      )}
    >
      <Sparkles className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
            {title}
          </span>
          {steps.map((step, i) => {
            const isFocused = i === safeIdx;
            const isDone = step.done;
            const clickable = !!onStepClick;
            const Pill = clickable ? "button" : "div";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and stable per render
                key={i}
                className="flex items-center gap-1.5"
              >
                <Pill
                  type={clickable ? "button" : undefined}
                  onClick={clickable ? () => onStepClick(i) : undefined}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-colors",
                    clickable && "cursor-pointer hover:bg-accent/40",
                    isDone && "border-primary/30 bg-primary/5 text-foreground",
                    isFocused &&
                      "border-primary bg-primary/10 text-foreground font-medium ring-1 ring-primary/30",
                    !isDone && !isFocused && "border-border bg-background/40 text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0",
                      isDone
                        ? "bg-primary text-primary-foreground"
                        : isFocused
                          ? "bg-primary/80 text-primary-foreground"
                          : "bg-muted text-foreground/70",
                    )}
                  >
                    {isDone ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span>{step.label}</span>
                </Pill>
                {i < steps.length - 1 && (
                  <ChevronRight className="w-3 h-3 text-muted-foreground/40 flex-shrink-0" />
                )}
              </div>
            );
          })}
        </div>
        {allDone ? (
          <p className="text-xs text-primary font-medium">
            All done — close this when you&apos;re ready.
          </p>
        ) : active?.hint ? (
          <p className="text-xs text-muted-foreground">{active.hint}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous step"
          title="Previous step"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next step"
          title="Next step"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss quickstart"
          title="Dismiss quickstart (won't show again)"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors ml-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
