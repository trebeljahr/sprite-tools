import { ImageResponse } from "next/og";

// iOS home-screen icon — larger variant of the favicon with a bit more
// polish since it's displayed at device resolution.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #0a0a0a 0%, #1c1c1e 100%)",
          borderRadius: 36,
        }}
      >
        <svg width="120" height="120" viewBox="0 0 24 24">
          <path
            d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z"
            fill="none"
            stroke="#22c55e"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z"
            fill="rgba(34, 197, 94, 0.15)"
          />
          {/* vertex dots */}
          <circle cx="12" cy="2" r="0.9" fill="#22c55e" />
          <circle cx="21" cy="7" r="0.9" fill="#22c55e" />
          <circle cx="21" cy="17" r="0.9" fill="#22c55e" />
          <circle cx="12" cy="22" r="0.9" fill="#22c55e" />
          <circle cx="3" cy="17" r="0.9" fill="#22c55e" />
          <circle cx="3" cy="7" r="0.9" fill="#22c55e" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
