"use client";

// Gate that hides AI-billed features (AI Character, AI Animation) until the
// user is signed in with credits available. Today this is a placeholder —
// swap `useSession()` + the "Sign in" handler with your auth provider
// (Clerk, Supabase Auth, NextAuth, Stack Auth, …) and wire the "credits"
// lookup to wherever you store them.
//
// The gating call site stays the same: wrap the page content in <AuthWall>.

import type * as React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock, Sparkles, Zap } from "lucide-react";
import Link from "next/link";

// ---- Auth + credits hook --------------------------------------------------

// Keep the shape small so swapping in a real provider is mechanical.
export interface Session {
  userId: string;
  displayName?: string;
  credits: number; // remaining generation credits
}

interface SessionState {
  status: "loading" | "unauthenticated" | "authenticated";
  session: Session | null;
}

// Replace with the real provider. For now we always return "unauthenticated"
// so AI pages show the paywall screen.
export function useSession(): SessionState {
  return { status: "unauthenticated", session: null };
}

async function signIn(): Promise<void> {
  // Replace with provider.signIn() + redirect, or open a modal.
  alert(
    "Authentication isn't wired up yet — this is a placeholder gate.\n\nSee src/components/auth-wall.tsx for integration notes.",
  );
}

// ---- UI -------------------------------------------------------------------

interface AuthWallProps {
  /** Feature label (e.g. "AI Character"). Shown in the gate screen. */
  feature: string;
  /** One-liner describing what the feature does and why it costs credits. */
  description: string;
  /** Estimated cost per run, displayed to set expectations. */
  costHint?: string;
  children: React.ReactNode;
}

export function AuthWall({ feature, description, costHint, children }: AuthWallProps) {
  const { status, session } = useSession();

  if (status === "loading") {
    return (
      <div className="container mx-auto py-16 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (status === "unauthenticated" || !session) {
    return <SignInGate feature={feature} description={description} costHint={costHint} />;
  }

  if (session.credits <= 0) {
    return <OutOfCreditsGate feature={feature} session={session} />;
  }

  // Gate passed — render the real page. The child is free to consume any
  // credits it needs; the wrapper doesn't track per-call usage.
  return <>{children}</>;
}

// ---- Gate screens ---------------------------------------------------------

function SignInGate({
  feature,
  description,
  costHint,
}: {
  feature: string;
  description: string;
  costHint?: string;
}) {
  return (
    <main className="container mx-auto py-12 px-4 max-w-xl">
      <Card className="shadow-lg ring-1 ring-primary/10">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3">
            <Lock className="w-6 h-6 text-primary" />
          </div>
          <CardTitle className="text-2xl flex items-center justify-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            {feature}
          </CardTitle>
          <CardDescription className="text-sm">{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 rounded-md border bg-muted/20 text-xs space-y-2">
            <p>
              This tool calls a paid AI provider (image or video generation). You need an account
              with credits to use it.
            </p>
            {costHint && (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Zap className="w-3.5 h-3.5" /> {costHint}
              </p>
            )}
          </div>

          <Button onClick={() => void signIn()} className="w-full" size="lg">
            Sign in to continue
          </Button>

          <div className="text-center text-xs text-muted-foreground">
            Don&rsquo;t need AI features?{" "}
            <Link href="/docs" className="underline hover:text-foreground">
              Everything else works without an account
            </Link>
            .
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function OutOfCreditsGate({ feature, session }: { feature: string; session: Session }) {
  return (
    <main className="container mx-auto py-12 px-4 max-w-xl">
      <Card className="shadow-lg ring-1 ring-destructive/20">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-3">
            <Zap className="w-6 h-6 text-destructive" />
          </div>
          <CardTitle className="text-2xl">Out of credits</CardTitle>
          <CardDescription>
            Hi {session.displayName ?? "there"} — {feature} needs credits to run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground text-center">
            Top up to keep generating. Everything non-AI in sprite-tools stays free.
          </p>
          <Button className="w-full" size="lg">
            Add credits
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
