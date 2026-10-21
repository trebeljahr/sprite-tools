import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/generate", {
  title: "AI Character",
  description:
    "Generate a character sprite from a text prompt with xAI, paid with your own xAI key or with AI credit.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
