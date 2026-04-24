"use client";

// Small button next to a tool's controls that copies the current URL
// (including the settings hash written by `useUrlSettings`) to the
// clipboard. Image data is not part of the URL — recipients must open
// their own sprite, but every knob auto-applies from the link.

import { Check, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface ShareSettingsButtonProps {
  /** Extra css classes on the button. */
  className?: string;
  /** Optional label for screen readers and tooltips. */
  label?: string;
}

export function ShareSettingsButton({
  className,
  label = "Share settings",
}: ShareSettingsButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast.success("Link copied — settings are baked into the URL.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard blocked — copy the URL manually.");
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      className={className}
      aria-label={label}
      title={label}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Share2 className="w-3.5 h-3.5" />
      )}
      <span className="ml-1.5">Share</span>
    </Button>
  );
}
