import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

const SITE = getSiteUrl();

// Rendered once at build time: the site is a static export.
export const dynamic = "force-static";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
