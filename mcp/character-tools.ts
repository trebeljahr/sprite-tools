import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { runCharacter } from "../src/lib/character/node";
export function registerCharacterTools(server: McpServer) {
  server.registerTool(
    "sprite_prepare_character_layers",
    {
      description:
        "Prepare aligned character PNG layers, original-visible/generated pixels, hidden masks, hierarchy and joint anchors. Supply a reviewed plan (inline or plan_path) for free local processing, or ai_draft for xAI vision polygon proposals. AI polygons are approximate, not semantic segmentation ground truth. Optional complete_parts generates occluded regions only; original visible pixels never change. Paid calls require allow_paid, max_cost_usd and XAI_API_KEY in the MCP server environment. Never pass keys in tool arguments. Results are cached by source/part content; uncertain dispatch is never automatically retried. Output is a layer-preparation bundle, not a finished rig. Use the Web Character Layers editor to correct polygons and inspect bends.",
      inputSchema: {
        input_path: z.string(),
        output_dir: z.string(),
        plan: z.record(z.unknown()).optional(),
        plan_path: z.string().optional(),
        ai_draft: z.boolean().default(false),
        description: z.string().max(1000).optional(),
        bend_test_parts: z.array(z.string()).max(32).default([]),
        complete_parts: z.array(z.string()).max(32).default([]),
        completion_paths: z.record(z.string()).optional(),
        allow_paid: z.boolean().default(false),
        max_cost_usd: z.number().finite().min(0).max(10).default(0),
        retry_uncertain: z.boolean().default(false),
      },
    },
    async (input) => {
      try {
        if (input.plan && input.plan_path) throw new Error("Supply plan or plan_path, not both.");
        const result = await runCharacter(
          {
            input: input.input_path,
            output: input.output_dir,
            plan:
              input.plan ??
              (input.plan_path ? JSON.parse(readFileSync(input.plan_path, "utf8")) : undefined),
            aiDraft: input.ai_draft,
            description: input.description,
            completeParts: input.complete_parts,
            bendTestParts: input.bend_test_parts,
            completionPaths: input.completion_paths,
            allowPaid: input.allow_paid,
            maxCostUsd: input.max_cost_usd,
            retryUncertain: input.retry_uncertain,
          },
          { apiKey: process.env.XAI_API_KEY ?? "" },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                e instanceof Error && !("code" in e) && !(e instanceof SyntaxError)
                  ? e.message
                  : "Character layer preparation failed. Check paths and input files.",
            },
          ],
        };
      }
    },
  );
}
