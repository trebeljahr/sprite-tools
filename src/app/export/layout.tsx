import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("/export", {
  title: "Engine export",
  description:
    "Convert sprite-tools metadata JSON into a Godot .tres, a Unity .meta, an Aseprite sheet JSON, or a Phaser/PixiJS atlas, in the browser.",
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
