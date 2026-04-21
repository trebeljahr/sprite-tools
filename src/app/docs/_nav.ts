// Single source of truth for the docs sidebar. Each section is a heading;
// each item is an MDX page under /docs.

export interface DocItem {
  href: string;
  label: string;
  blurb?: string;
}

export interface DocSection {
  label: string;
  items: DocItem[];
}

export const DOCS_SECTIONS: DocSection[] = [
  {
    label: "Start here",
    items: [
      { href: "/docs", label: "Introduction", blurb: "What sprite-tools is and why" },
      { href: "/docs/install", label: "Install", blurb: "CLI, MCP server, web app" },
      { href: "/docs/quickstart", label: "Quickstart", blurb: "5 minutes end-to-end" },
    ],
  },
  {
    label: "Web app",
    items: [
      { href: "/docs/web/overview", label: "Overview tab" },
      { href: "/docs/web/collision", label: "Collision" },
      { href: "/docs/web/pivot", label: "Pivot" },
      { href: "/docs/web/tags", label: "Animation tags" },
      { href: "/docs/web/pixelate", label: "Pixelate" },
      { href: "/docs/web/normal-map", label: "Normal map" },
      { href: "/docs/web/palette", label: "Palette" },
      { href: "/docs/web/atlas", label: "Atlas packer" },
      { href: "/docs/web/gif", label: "GIF export" },
    ],
  },
  {
    label: "CLI",
    items: [
      { href: "/docs/cli", label: "CLI overview" },
      { href: "/docs/cli/reference", label: "Command reference" },
      { href: "/docs/cli/recipes", label: "Recipes" },
    ],
  },
  {
    label: "MCP server",
    items: [
      { href: "/docs/mcp", label: "MCP overview" },
      { href: "/docs/mcp/install", label: "Install in Claude Desktop" },
      { href: "/docs/mcp/tools", label: "Tool catalog" },
    ],
  },
  {
    label: "Reference",
    items: [
      { href: "/docs/reference/json-schemas", label: "JSON output schemas" },
      { href: "/docs/reference/algorithms", label: "Algorithm notes" },
      { href: "/docs/reference/contributing", label: "Contributing" },
    ],
  },
];

export function flattenDocs(): DocItem[] {
  return DOCS_SECTIONS.flatMap((s) => s.items);
}
