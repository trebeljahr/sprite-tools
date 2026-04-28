import { ImageResponse } from "next/og";

// Social preview card for link unfurls (Hacker News, Twitter/X, Discord,
// Slack, LinkedIn). 1200×630 is the de-facto standard.

export const alt =
  "sprite-tools — a batteries-included toolkit for turning AI-generated or hand-drawn sprites into game-ready assets";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#09090b",
        color: "#fafafa",
        padding: 64,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* Faint grid backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* Pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.04)",
          fontSize: 20,
          color: "#a1a1aa",
          width: "fit-content",
          marginBottom: 24,
        }}
      >
        <span style={{ color: "#22c55e", fontSize: 24 }}>◆</span>
        Game-ready 2D sprite toolkit
      </div>

      {/* Title */}
      <div style={{ fontSize: 128, fontWeight: 800, letterSpacing: -2, lineHeight: 1 }}>
        sprite-tools
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontSize: 30,
          color: "#a1a1aa",
          marginTop: 24,
          maxWidth: 960,
          lineHeight: 1.3,
        }}
      >
        Collision polygons · pivots · animation tags · pixel-art conversion · normal maps · palette
        swap · atlas packing · GIF export.
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom row: surfaces */}
      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 20,
          color: "#d4d4d8",
        }}
      >
        {["Web app", "CLI", "MCP server"].map((s) => (
          <div
            key={s}
            style={{
              padding: "8px 16px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              display: "flex",
            }}
          >
            {s}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#22c55e" }}>
          {/* Hexagon glyph echoing the favicon */}
          <svg aria-hidden="true" width="48" height="48" viewBox="0 0 24 24">
            <path
              d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z"
              fill="none"
              stroke="#22c55e"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
