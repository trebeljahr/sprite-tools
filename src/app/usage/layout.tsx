import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Generation usage",
  robots: { index: false, follow: false },
};
export default function UsageLayout({ children }: { children: React.ReactNode }) {
  return children;
}
