import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Character Layers",
  description:
    "Prepare aligned character art layers, hidden areas and joint anchors before rigging.",
  alternates: { canonical: "/character-layers" },
};
export default function CharacterLayersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
