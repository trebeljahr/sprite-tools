"use client";

// Compile-time gate for AI pages. When NEXT_PUBLIC_ENABLE_AI is false
// (default), `/generate` and `/animate` render this placeholder instead of
// their real content — no blank page, no 404, just a clear "coming soon"
// with pointers to the tools that already work.

import Link from "next/link";
import { Lock, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AI_ENABLED } from "@/lib/features";

interface AiGateProps {
  feature: string;
  description: string;
  children: React.ReactNode;
}

export function AiGate({ feature, description, children }: AiGateProps) {
  if (AI_ENABLED) return <>{children}</>;

  return (
    <main className="container mx-auto py-12 px-4 max-w-xl">
      <Card className="shadow-lg ring-1 ring-primary/10">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center mx-auto mb-3">
            <Lock className="w-6 h-6 text-muted-foreground" />
          </div>
          <CardTitle className="text-2xl flex items-center justify-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            {feature}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 rounded-md border bg-muted/20 text-xs text-muted-foreground">
            This feature depends on paid third-party AI providers and isn&rsquo;t turned on yet. The
            rest of sprite-tools — collision polygons, pivots, tags, pixelation, normal maps,
            palette swap, atlas packing, GIF export — all work today, for free, entirely in your
            browser or via the CLI.
          </div>
          <div className="flex justify-center gap-3">
            <Link href="/docs/quickstart" className={cn(buttonVariants({ size: "sm" }))}>
              Try what ships today
            </Link>
            <Link href="/" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
              Back to home
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
