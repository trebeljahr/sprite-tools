import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { MetadataRoute } from "next";
import { AI_ENABLED } from "@/lib/features";
import { getSiteUrl } from "@/lib/site-url";

const SITE = getSiteUrl();
const APP_DIR = join(process.cwd(), "src", "app");
const DOCS_DIR = join(APP_DIR, "docs");

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

type RouteEntry = {
  path: string;
  lastModified: Date;
};

async function discoverDocRoutes(dir = DOCS_DIR): Promise<RouteEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const routes = await Promise.all(
    entries.flatMap(async (entry) => {
      const filePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        return discoverDocRoutes(filePath);
      }

      if (!entry.isFile() || entry.name !== "page.mdx") {
        return [];
      }

      const routeDir = dirname(filePath);
      const path = `/${relative(APP_DIR, routeDir).split(sep).join("/")}`;
      const { mtime } = await stat(filePath);

      return [{ path, lastModified: mtime }];
    }),
  );

  return routes.flat().sort((a, b) => a.path.localeCompare(b.path));
}

function routeQuality(path: string) {
  if (path === "/") {
    return { changeFrequency: "weekly" as const, priority: 1 };
  }

  if (path === "/privacy") {
    return { changeFrequency: "yearly" as const, priority: 0.3 };
  }

  if (path.startsWith("/docs")) {
    return { changeFrequency: "monthly" as const, priority: path === "/docs" ? 0.75 : 0.6 };
  }

  return { changeFrequency: "weekly" as const, priority: 0.8 };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const staticRoutes = ["/", ...TOOL_ROUTES, ...(AI_ENABLED ? AI_ROUTES : []), "/privacy"].map(
    (path) => ({ path, lastModified }),
  );
  const routes = [...staticRoutes, ...(await discoverDocRoutes())];

  return routes.map((path) => ({
    url: `${SITE}${path.path}`,
    lastModified: path.lastModified,
    ...routeQuality(path.path),
  }));
}
