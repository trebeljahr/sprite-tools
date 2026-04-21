'use client';

import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

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
            <div className="container flex h-14 items-center max-w-4xl mx-auto px-4">
              <div className="mr-4 flex">
                <Link className="mr-6 flex items-center space-x-2 font-bold" href="/">
                  SpriteTools
                </Link>
                <nav className="flex items-center space-x-6 text-sm font-medium">
                  <Link 
                    href="/generate" 
                    className={cn(
                      "transition-colors hover:text-foreground/80",
                      pathname === "/generate" ? "text-foreground" : "text-foreground/60"
                    )}
                  >
                    Design
                  </Link>
                  <Link 
                    href="/" 
                    className={cn(
                      "transition-colors hover:text-foreground/80",
                      pathname === "/" ? "text-foreground" : "text-foreground/60"
                    )}
                  >
                    Animate
                  </Link>
                  <Link 
                    href="/spritesheet" 
                    className={cn(
                      "transition-colors hover:text-foreground/80",
                      pathname === "/spritesheet" ? "text-foreground" : "text-foreground/60"
                    )}
                  >
                    Stitch
                  </Link>
                  <Link
                    href="/lasso"
                    className={cn(
                      "transition-colors hover:text-foreground/80",
                      pathname === "/lasso" ? "text-foreground" : "text-foreground/60"
                    )}
                  >
                    Lasso
                  </Link>
                  <Link
                    href="/collision"
                    className={cn(
                      "transition-colors hover:text-foreground/80",
                      pathname === "/collision" ? "text-foreground" : "text-foreground/60"
                    )}
                  >
                    Collision
                  </Link>
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
