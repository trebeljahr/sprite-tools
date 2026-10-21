import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/spritesheet", {
  title: "Sheet Builder",
  description:
    "Turn video, GIF, existing sheets, or loose frames into clean exported sprite sheets or ZIPs.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
