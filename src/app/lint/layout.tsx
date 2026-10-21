import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/lint", {
  title: "Sheet Lint",
  description:
    "Lint a sprite sheet in the browser: detect the grid, find chroma-key fringe, frame bleed, pivot jumps, duplicate or empty cells and palette noise, and see every finding drawn on the sheet.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
