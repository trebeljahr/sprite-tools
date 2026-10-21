import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/lasso", {
  title: "Lasso cutout",
  description:
    "Manually cut one object from an image and export a clean PNG for sheet building, atlases, or metadata tools.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
