import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/background-removal", {
  title: "Background removal",
  description:
    "Chroma-key the background out of a video, a sprite sheet, an Aseprite file, or loose images in the browser, then auto-crop and export PNGs, a ZIP, or a stitched sheet.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
