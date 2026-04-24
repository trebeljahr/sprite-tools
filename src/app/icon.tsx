import { ImageResponse } from "next/og";

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
        {/* 3x3 grid — matches the "Sheet Builder" / spritesheet mark. */}
        <svg width="22" height="22" viewBox="0 0 24 24">
          <rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="2"
            fill="none"
            stroke="#22c55e"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M3 9 H21 M3 15 H21 M9 3 V21 M15 3 V21"
            stroke="#22c55e"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
