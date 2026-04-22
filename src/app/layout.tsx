'use client';

import * as React from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SiteFooter } from "@/components/site-footer";
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
import { ChevronDown, Lock, Menu } from "lucide-react";
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
  { href: "/spritesheet", label: "Sheet Builder" },
  { href: "/docs", label: "Docs" },
];

interface ToolLink {
  href: string;
  label: string;
  hint: string;
  paid?: boolean;
}

const TOOL_GROUPS: Array<{ label: string; items: ToolLink[] }> = [
  {
    label: "AI (sign-in required)",
    items: [
      { href: "/generate", label: "AI Character", hint: "generate sprite art", paid: true },
      { href: "/animate", label: "AI Animation", hint: "animate a character", paid: true },
    ],
  },
  {
    label: "Extract",
    items: [
      { href: "/lasso", label: "Lasso", hint: "manual polygon cutout" },
    ],
  },
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
          <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-14 items-center max-w-5xl mx-auto px-4">
              <div className="mr-4 flex items-center">
                <Link className="mr-6 flex items-center space-x-2 font-bold" href="/">
                  SpriteTools
                </Link>

                {/* Mobile nav: hamburger → dropdown. Hides the full nav below md. */}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="md:hidden inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
                    aria-label="Open navigation"
                  >
                    <Menu className="h-5 w-5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-64">
                    <DropdownMenuGroup>
                      {PRIMARY.map((p) => (
                        <DropdownMenuItem
                          key={p.href}
                          render={<Link href={p.href} />}
                        >
                          <span className="font-medium">{p.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                    {TOOL_GROUPS.map((group) => (
                      <React.Fragment key={group.label}>
                        <DropdownMenuSeparator />
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
                              <span className="font-medium flex items-center gap-1.5">
                                {item.label}
                                {item.paid && (
                                  <Lock className="h-2.5 w-2.5 text-muted-foreground" />
                                )}
                              </span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </React.Fragment>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Desktop nav: inline links + Tools dropdown. */}
                <nav className="hidden md:flex items-center space-x-6 text-sm font-medium">
                  {PRIMARY.map((p) => {
                    // /docs should highlight on every sub-route; other
                    // primaries use strict equality.
                    const active =
                      p.href === "/docs"
                        ? pathname === "/docs" || pathname.startsWith("/docs/")
                        : pathname === p.href;
                    return (
                      <Link
                        key={p.href}
                        href={p.href}
                        className={cn(
                          "transition-colors hover:text-foreground/80",
                          active ? "text-foreground" : "text-foreground/60",
                        )}
                      >
                        {p.label}
                      </Link>
                    );
                  })}

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
                                <span className="font-medium flex items-center gap-1.5">
                                  {item.label}
                                  {item.paid && (
                                    <Lock className="h-2.5 w-2.5 text-muted-foreground" />
                                  )}
                                </span>
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
          <div className="flex-1 flex flex-col">{children}</div>
          <SiteFooter />
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
