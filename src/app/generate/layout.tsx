import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/generate", {
  title: "AI Character",
  description:
    "Generate a character sprite from a text prompt, then send it into animation or sheet-building workflows.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
