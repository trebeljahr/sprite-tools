import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/animate", {
  title: "Video Studio",
  description:
    "Generate video with local Google or xAI keys, then export a transparent sprite sheet and collision metadata.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
