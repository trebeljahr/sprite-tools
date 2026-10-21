import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/gif", {
  title: "GIF export",
  description:
    "Export sprite sheet animations as animated GIF or WebM previews with scaling, alpha cutoff, per-frame timing, and playback controls.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
