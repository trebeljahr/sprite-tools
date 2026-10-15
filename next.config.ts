import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import createMDX from "@next/mdx";

// The accounts server (packages/server) in `pnpm dev`.
const DEV_API_ORIGIN = process.env.DEV_API_ORIGIN ?? "http://127.0.0.1:3472";

// Turbopack requires MDX plugin options to be serializable, so we pass plugin
// package names as strings rather than imported function references.
const withMDX = createMDX({
  extension: /\.(md|mdx)$/,
  options: {
    remarkPlugins: [["remark-gfm", {}]],
    rehypePlugins: [
      ["rehype-slug", {}],
      [
        "rehype-autolink-headings",
        {
          behavior: "wrap",
          properties: { className: ["heading-anchor"] },
        },
      ],
    ],
  },
});

// Production builds are a static export (`out/`) that a Cloudflare Worker
// serves (wrangler.jsonc). `/api/*` on the same hostname reaches the accounts
// server through a Workers route with no Worker. Response headers live in
// public/_headers. In `next dev` a rewrite stands in for that route.
export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return withMDX({
    reactCompiler: true,
    deploymentId: process.env.NEXT_DEPLOYMENT_ID,
    pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
    ...(dev
      ? {
          async rewrites() {
            return [{ source: "/api/:path*", destination: `${DEV_API_ORIGIN}/api/:path*` }];
          },
        }
      : { output: "export" }),
  });
}
