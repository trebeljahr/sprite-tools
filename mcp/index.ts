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
import { registerAllTools } from "./tools";

async function main() {
  const server = new McpServer({
    name: "sprite-tools",
    version: "0.1.0",
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
