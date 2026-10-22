import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SiteFooter } from "@/components/site-footer";
import { ThemeProvider } from "@/components/theme-provider";
import { ClientProviders } from "@/components/client-providers";
import { getSiteUrl } from "@/lib/site-url";
import { SiteNav } from "./site-nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const plausibleDomain = "sprites.trebeljahr.com";
const plausibleScriptUrl =
  "https://plausible.trebeljahr.com/js/script.file-downloads.hash.outbound-links.pageview-props.revenue.tagged-events.js";

const siteDescription =
  "Prepare sprite sheets for your game. Remove backgrounds, set pivots, trace collision shapes, and export assets in the browser or CLI.";

// Site-wide metadata. Individual routes can override via their own
// `export const metadata` — the root values here serve as defaults and
// as the fallback social preview.
export const metadata: Metadata = {
  other: process.env.NEXT_PUBLIC_BUILD_COMMIT
    ? { "build-commit": process.env.NEXT_PUBLIC_BUILD_COMMIT }
    : {},
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "sprite-tools — game-ready 2D sprite toolkit",
    template: "%s · sprite-tools",
  },
  description: siteDescription,
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
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "sprite-tools",
    url: "/",
    title: "sprite-tools — game-ready 2D sprite toolkit",
    description: siteDescription,
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "sprite-tools social preview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "sprite-tools",
    description: siteDescription,
    images: [
      {
        url: "/twitter-image",
        alt: "sprite-tools social preview",
      },
    ],
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
        <Script id="plausible-loader" strategy="afterInteractive">
          {`
              (function () {
                var domain = ${JSON.stringify(plausibleDomain)};
                if (location.hostname !== domain) return;
                window.plausible = window.plausible || function() {
                  (window.plausible.q = window.plausible.q || []).push(arguments);
                };
                var script = document.createElement("script");
                script.defer = true;
                script.dataset.domain = domain;
                script.src = ${JSON.stringify(plausibleScriptUrl)};
                document.head.appendChild(script);
              })();
            `}
        </Script>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ClientProviders>
            <SiteNav />
            <div className="flex-1 flex flex-col">{children}</div>
            <SiteFooter />
            <Toaster position="bottom-right" />
          </ClientProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
