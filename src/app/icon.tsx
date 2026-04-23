import { ImageResponse } from "next/og";

// Favicon. Auto-generated on each build so the mark stays in sync with
// the rest of the app's identity — swap the SVG / colors and every
// platform's favicon updates.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          borderRadius: 6,
        }}
      >
        {/* 6-sided polygon — the same "Hexagon" icon Collision uses. */}
        <svg width="22" height="22" viewBox="0 0 24 24">
          <path
            d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z"
            fill="#22c55e"
            stroke="#22c55e"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
