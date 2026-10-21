import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/tags", {
  title: "Animation tags",
  description:
    "Split sprite sheets into named animation clips with frame ranges, playback direction, per-tag FPS, and per-frame hold times.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
