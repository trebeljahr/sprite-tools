import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/collision", {
  title: "Collision",
  description:
    "Trace collision polygons from sprite alpha and export per-frame JSON for 2D physics engines.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
