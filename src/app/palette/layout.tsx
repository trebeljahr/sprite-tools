import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/palette", {
  title: "Palette",
  description:
    "Extract dominant sprite colors, remap whole shading ramps in OKLCH, and export named recolor variants as PNGs plus a manifest.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
