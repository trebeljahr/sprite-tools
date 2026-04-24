"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Compass,
  Film,
  Grid3x3,
  Hexagon,
  Layers,
  Palette as PaletteIcon,
  Scissors,
  Sparkles,
  Terminal,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CollisionDemo } from "@/components/collision-demo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const TOOLS = [
  { href: "/spritesheet", label: "Sheet Builder", icon: Scissors, blurb: "Slice video or existing sheet into clean frames with chroma key + crop." },
  { href: "/collision", label: "Collision", icon: Hexagon, blurb: "Trace tight per-frame collision polygons for physics engines." },
  { href: "/pixelate", label: "Pixelate", icon: Grid3x3, blurb: "Turn any sprite into pixel art — Game Boy, PICO-8, NES palettes." },
  { href: "/normal-map", label: "Normals", icon: Compass, blurb: "Alpha/luminance → tangent-space normal map for 2D dynamic lighting." },
  { href: "/palette", label: "Palette", icon: PaletteIcon, blurb: "Extract dominant colors, swap any of them to recolor the sprite." },
  { href: "/atlas", label: "Atlas", icon: Boxes, blurb: "Bin-pack many sprites into one PNG + TexturePacker manifest." },
  { href: "/gif", label: "GIF", icon: Film, blurb: "Animated GIF / WebM export from a sprite sheet." },
  { href: "/tags", label: "Tags", icon: Layers, blurb: "Split a sheet into named animation clips — idle, run, attack." },
];

export default function HomePage() {
  return (
    <main className="container mx-auto px-4 py-16 max-w-5xl">
      <section className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center mb-20">
        <div className="text-center md:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-muted/40 text-xs text-muted-foreground mb-4">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            Game-ready 2D sprite toolkit
          </div>
          <h1 className="text-5xl font-bold tracking-tight mb-4">sprite-tools</h1>
          <p className="text-lg text-muted-foreground max-w-xl">
            A batteries-included toolkit for turning AI-generated or hand-drawn
            sprites into <strong className="text-foreground">game-ready assets</strong> —
            collision polygons, pivots, animation tags, pixel-art conversion,
            normal maps, palette swap, atlas packing, GIF export.
          </p>
          <p className="text-sm text-muted-foreground mt-3 max-w-xl">
            Web app, CLI, and MCP server — all sharing the same algorithms and JSON contracts.
          </p>
          <div className="flex items-center justify-center md:justify-start gap-3 mt-8">
            <Link
              href="/docs/quickstart"
              className={cn(buttonVariants({ size: "lg" }))}
            >
              Quickstart <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
            <Link
              href="/docs"
              className={cn(buttonVariants({ size: "lg", variant: "outline" }))}
            >
              <BookOpen className="w-4 h-4 mr-2" /> Docs
            </Link>
          </div>
        </div>

        {/* Live algorithm demo — the real generateOutline code path,
            not a screenshot or a recording. */}
        <CollisionDemo />
      </section>

      <section className="mb-16">
        <h2 className="text-sm uppercase tracking-wider text-muted-foreground font-semibold mb-4">
          Try a tool
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {TOOLS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="group rounded-lg border p-4 hover:border-primary/40 hover:bg-accent/40 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1 font-semibold">
                <t.icon className="w-4 h-4 text-primary" />
                {t.label}
                <ArrowRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-xs text-muted-foreground leading-snug">{t.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-16">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
            <Terminal className="w-5 h-5 text-primary" />
            <div>
              <CardTitle className="text-base">CLI</CardTitle>
              <CardDescription className="text-xs">
                13 composable subcommands. Pipe-friendly.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <pre className="text-[11px] bg-muted/40 rounded-md border p-3 overflow-x-auto">
              {`sprite-tools meta hero.png \\
  --collision --tolerance 4 \\
  --pivot bottom-center \\
  --tag idle=0-5 --tag run=6-11 \\
  -o hero.json`}
            </pre>
            <Link
              href="/docs/cli"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "w-full")}
            >
              CLI docs
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
            <Sparkles className="w-5 h-5 text-primary" />
            <div>
              <CardTitle className="text-base">MCP server</CardTitle>
              <CardDescription className="text-xs">
                Claude Desktop + any MCP client drive the pipeline directly.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <pre className="text-[11px] bg-muted/40 rounded-md border p-3 overflow-x-auto">
              {`"mcpServers": {
  "sprite-tools": {
    "command": "sprite-tools-mcp"
  }
}`}
            </pre>
            <Link
              href="/docs/mcp"
              className={cn(buttonVariants({ size: "sm", variant: "outline" }), "w-full")}
            >
              MCP docs
            </Link>
          </CardContent>
        </Card>
      </section>

      <footer className="text-center text-xs text-muted-foreground pb-8">
        Open-source under the{" "}
        <Link
          href="https://github.com/trebeljahr/sprite-tools/blob/main/LICENSE"
          className="underline hover:text-foreground"
        >
          MIT license
        </Link>
        .
      </footer>
    </main>
  );
}
