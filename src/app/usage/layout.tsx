import { pageMetadata } from "@/lib/page-metadata";

export const metadata = {
  ...pageMetadata("/usage", {
    title: "Generation usage",
    description: "View your sprite-tools image generation usage and AI credit history.",
  }),
  robots: { index: false, follow: false },
};
export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
