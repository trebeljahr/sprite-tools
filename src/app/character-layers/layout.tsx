import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/character-layers", {
  title: "Character Layers",
  description:
    "Prepare aligned character art layers, hidden areas and joint anchors before rigging.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
