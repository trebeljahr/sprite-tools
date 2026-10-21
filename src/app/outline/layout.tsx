import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/outline", {
  title: "Outline & shadow",
  description:
    "Add a pixel-exact outer or inner outline and a drop shadow to a sprite or a whole sheet in the browser, with control over thickness, connectivity, alpha threshold, and canvas overflow.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
