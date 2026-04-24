import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SiteFooter } from "@/components/site-footer";
import { ThemeProvider } from "@/components/theme-provider";
import { SiteNav } from "./site-nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Site-wide metadata. Individual routes can override via their own
// `export const metadata` — the root values here serve as defaults and
// as the fallback social preview.
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3471",
  ),
  title: {
    default: "sprite-tools — game-ready 2D sprite toolkit",
    template: "%s · sprite-tools",
  },
  description:
    "Batteries-included toolkit for turning AI-generated or hand-drawn sprites into game-ready assets. Collision polygons, pivots, animation tags, pixel-art conversion, normal maps, palette swap, atlas packing, GIF export. Web app + CLI + MCP server.",
  applicationName: "sprite-tools",
  keywords: [
    "sprite",
    "sprite sheet",
    "collision polygon",
    "game assets",
    "pixel art",
    "normal map",
    "atlas packer",
    "aseprite",
    "2D game",
    "mcp",
  ],
  authors: [{ name: "sprite-tools contributors" }],
  openGraph: {
    type: "website",
    siteName: "sprite-tools",
    title: "sprite-tools — game-ready 2D sprite toolkit",
    description:
      "Web app, CLI, and MCP server for collision polygons, pivots, animation tags, pixel-art conversion, normal maps, palette swap, atlas packing, and GIF export.",
  },
  twitter: {
    card: "summary_large_image",
    title: "sprite-tools",
    description:
      "Game-ready 2D sprite toolkit — collision polygons, pivots, tags, pixel art, normals, palette, atlas, GIF.",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SiteNav />
          <div className="flex-1 flex flex-col">{children}</div>
          <SiteFooter />
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
