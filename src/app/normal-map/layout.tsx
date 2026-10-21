import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/normal-map", {
  title: "Normal map",
  description:
    "Generate tangent-space normal maps from sprite alpha or luminance for 2D dynamic lighting.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
