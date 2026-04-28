"use client";

// Last-resort error boundary. Catches crashes in the root layout
// itself (provider bugs, font loader failures, theme errors) — the
// per-tool `error.tsx` boundaries can't reach above the layout. Next.js
// requires this file to render its own <html> / <body>, since the
// failing layout is what would normally provide them.

import { useEffect } from "react";
import { captureException } from "@/lib/error-reporting";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { digest: error.digest, scope: "global" });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          minHeight: "100vh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#09090b",
          color: "#fafafa",
        }}
      >
        <main
          style={{
            maxWidth: 480,
            padding: 32,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 24, marginBottom: 12 }}>Something went very wrong</h1>
          <p style={{ color: "#a1a1aa", marginBottom: 20, lineHeight: 1.5 }}>
            sprite-tools failed to render. The error has been reported. You can try reloading; if it
            keeps happening, please file an issue.
          </p>
          <pre
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              padding: 12,
              borderRadius: 8,
              background: "#1c1c1e",
              color: "#fca5a5",
              textAlign: "left",
              overflowX: "auto",
              marginBottom: 20,
            }}
          >
            {error.message || String(error)}
            {error.digest ? `\ndigest: ${error.digest}` : ""}
          </pre>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #3f3f46",
              background: "#27272a",
              color: "#fafafa",
              cursor: "pointer",
              marginRight: 8,
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #3f3f46",
              background: "transparent",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
