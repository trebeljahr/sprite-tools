import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/pivot", {
  title: "Pivot",
  description:
    "Pick per-frame sprite anchor points for rotation, scaling, placement, and engine import workflows.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
