import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/playground", {
  title: "Sprite Playground",
  description:
    "Test sprite movement, attacks and animation transitions with a keyboard controller.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
