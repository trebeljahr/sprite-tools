"use client";

// Per-tool error fallback. Next.js App Router uses an `error.tsx` file in
// each route directory as that route's error boundary — drop this component
// as the default export from those files:
//
//   // src/app/collision/error.tsx
//   "use client";
//   export { ToolErrorBoundaryPage as default } from "@/components/tool-error-boundary";
//
// The signature matches what Next passes in: an `Error` plus a `reset`
// callback that re-renders the route.

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { captureException } from "@/lib/error-reporting";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export function ToolErrorBoundaryPage({ error, reset }: Props) {
  // Forward to GlitchTip on mount (once per thrown error). Safe when
  // reporting is disabled — captureException short-circuits.
  useEffect(() => {
    captureException(error, { digest: error.digest });
  }, [error]);

  return (
    <main className="container mx-auto py-12 px-4 max-w-xl">
      <Card className="ring-1 ring-destructive/20">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <CardTitle className="text-2xl">Something went wrong</CardTitle>
          <CardDescription>
            This tool crashed while rendering. Your source is still saved; the rest of the app is
            fine.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <pre className="text-[11px] font-mono text-destructive/80 p-3 rounded-md bg-destructive/5 border border-destructive/20 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
            {error.message || String(error)}
            {error.digest && `\ndigest: ${error.digest}`}
          </pre>
          <div className="flex justify-center gap-3">
            <Button onClick={reset}>
              <RotateCw className="w-4 h-4 mr-2" />
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
