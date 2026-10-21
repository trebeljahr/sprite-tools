import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/atlas", {
  title: "Atlas packer",
  description:
    "Pack separate sprite PNGs into one atlas texture with a TexturePacker-style JSON manifest.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
