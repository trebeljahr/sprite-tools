import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/nine-slice", {
  title: "Nine-slice",
  description:
    "Set the four nine-slice insets on a panel sprite, check them in a live stretch preview, and export them as JSON, a stretched PNG, or an Android .9.png.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
