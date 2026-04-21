'use client';

import * as React from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Top-level links (the main pipeline flow) stay flat in the nav. The grab-bag
// of metadata / transform / export tools go behind a single "Tools" dropdown
// so the navbar stops wrapping on narrow screens.
const PRIMARY = [
  { href: "/generate", label: "Design" },
  { href: "/", label: "Animate" },
  { href: "/spritesheet", label: "Stitch" },
  { href: "/lasso", label: "Lasso" },
  { href: "/overview", label: "Overview" },
];

interface ToolLink {
  href: string;
  label: string;
  hint: string;
}

const TOOL_GROUPS: Array<{ label: string; items: ToolLink[] }> = [
  {
    label: "Metadata",
    items: [
      { href: "/collision", label: "Collision", hint: "per-frame polygons" },
      { href: "/pivot", label: "Pivot", hint: "anchor points" },
      { href: "/tags", label: "Tags", hint: "named frame ranges" },
    ],
  },
  {
    label: "Transform",
    items: [
      { href: "/pixelate", label: "Pixelate", hint: "downscale + quantize" },
      { href: "/normal-map", label: "Normals", hint: "tangent-space normal map" },
      { href: "/palette", label: "Palette", hint: "extract + swap colors" },
    ],
  },
  {
    label: "Export",
    items: [
      { href: "/atlas", label: "Atlas", hint: "bin-pack multiple sprites" },
      { href: "/gif", label: "GIF", hint: "animated GIF / WebM" },
    ],
  },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();
  const isToolActive = TOOL_GROUPS.some((g) =>
    g.items.some((i) => pathname === i.href),
  );

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
          <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-14 items-center max-w-5xl mx-auto px-4">
              <div className="mr-4 flex">
                <Link className="mr-6 flex items-center space-x-2 font-bold" href="/">
                  SpriteTools
                </Link>
                <nav className="flex items-center space-x-6 text-sm font-medium">
                  {PRIMARY.map((p) => (
                    <Link
                      key={p.href}
                      href={p.href}
                      className={cn(
                        "transition-colors hover:text-foreground/80",
                        pathname === p.href
                          ? "text-foreground"
                          : "text-foreground/60",
                      )}
                    >
                      {p.label}
                    </Link>
                  ))}

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className={cn(
                        "inline-flex items-center gap-1 transition-colors hover:text-foreground/80 outline-none",
                        isToolActive ? "text-foreground" : "text-foreground/60",
                      )}
                    >
                      Tools <ChevronDown className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-64">
                      {TOOL_GROUPS.map((group, i) => (
                        <React.Fragment key={group.label}>
                          {i > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                            {group.items.map((item) => (
                              <DropdownMenuItem
                                key={item.href}
                                render={
                                  <Link
                                    href={item.href}
                                    className={cn(
                                      "flex items-center justify-between gap-4",
                                      pathname === item.href && "bg-accent/50",
                                    )}
                                  />
                                }
                              >
                                <span className="font-medium">{item.label}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {item.hint}
                                </span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        </React.Fragment>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </nav>
              </div>
              <div className="flex flex-1 items-center justify-end">
                <ThemeToggle />
              </div>
            </div>
          </header>
          {children}
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
