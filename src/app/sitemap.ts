import type { MetadataRoute } from "next";
import { AI_ENABLED } from "@/lib/features";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3471";

const TOOL_ROUTES = [
  "/spritesheet",
  "/collision",
  "/pivot",
  "/tags",
  "/pixelate",
  "/normal-map",
  "/palette",
  "/atlas",
  "/gif",
  "/lasso",
];

const AI_ROUTES = ["/generate", "/animate"];

const DOC_ROUTES = [
  "/docs",
  "/docs/install",
  "/docs/quickstart",
  "/docs/cli",
  "/docs/cli/reference",
  "/docs/cli/recipes",
  "/docs/mcp",
  "/docs/mcp/install",
  "/docs/mcp/tools",
  "/docs/reference/algorithms",
  "/docs/reference/json-schemas",
  "/docs/reference/contributing",
  "/docs/web/collision",
  "/docs/web/pivot",
  "/docs/web/tags",
  "/docs/web/pixelate",
  "/docs/web/normal-map",
  "/docs/web/palette",
  "/docs/web/atlas",
  "/docs/web/gif",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const routes = [
    "/",
    ...TOOL_ROUTES,
    ...(AI_ENABLED ? AI_ROUTES : []),
    ...DOC_ROUTES,
    "/privacy",
  ];

  return routes.map((path) => ({
    url: `${SITE}${path}`,
    lastModified,
    changeFrequency: path.startsWith("/docs") ? "monthly" : "weekly",
    priority: path === "/" ? 1 : path.startsWith("/docs") ? 0.6 : 0.8,
  }));
}
