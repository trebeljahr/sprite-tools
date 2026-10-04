import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
  reactCompiler: true,
  deploymentId: process.env.NEXT_DEPLOYMENT_ID,
  async headers() {
    return [
      {
        source: "/version.json",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
  pageExtensions: ["ts", "tsx", "js", "jsx", "md", "mdx"],
};

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

export default withMDX(nextConfig);
