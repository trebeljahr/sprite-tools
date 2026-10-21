import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/pixelate", {
  title: "Pixelate",
  description:
    "Convert sprites into pixel art with box downscaling, palette quantization, dithering, alpha cleanup, and pixel-art upscaling (Scale2x, Scale3x, Eagle, xBR).",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
