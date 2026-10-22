import { pageMetadata } from "@/lib/page-metadata";
export const metadata = pageMetadata("/motion-workbench", {
  title: "Motion Workbench",
  description:
    "Adapt reusable character motions, blend joint poses and export transparent sprite sheets.",
});
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
