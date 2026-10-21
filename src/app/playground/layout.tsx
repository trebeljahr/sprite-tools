import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Sprite Playground",
  description:
    "Test sprite movement, attacks and animation transitions with a keyboard controller.",
  alternates: { canonical: "/playground" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
