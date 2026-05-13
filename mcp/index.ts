#!/usr/bin/env node

// sprite-tools MCP server.
//
// Exposes the same algorithms the CLI wraps, but via the Model Context
// Protocol so Claude Desktop / any MCP client can invoke them with
// structured arguments and structured results (no stdout parsing, no
// shelling out).

import "../cli/lib/imagedata-shim";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getCliVersion } from "../cli/lib/version";
import { registerAllTools } from "./tools";

function printHelp() {
  process.stdout.write(
    [
      "sprite-tools-mcp",
      "",
      "MCP server for sprite-tools. MCP clients start this binary over stdio.",
      "",
      "Usage:",
      "  sprite-tools-mcp          start the MCP stdio server",
      "  sprite-tools-mcp --help   show this help",
      "  sprite-tools-mcp --version",
      "",
      "Install:",
      "  npm install -g @trebeljahr/sprite-tools",
      "",
    ].join("\n"),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${getCliVersion()}\n`);
    return;
  }

  const server = new McpServer({
    name: "sprite-tools",
    version: getCliVersion(),
  });
  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP runs over stdio; stay alive until transport closes.
}

main().catch((err) => {
  process.stderr.write(
    `sprite-tools MCP fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
