import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { motionStudy, studySchema } from "../src/lib/motion/study";
export function registerMotionTools(server: McpServer) {
  server.registerTool(
    "sprite_motion_study",
    {
      description:
        "Create a reusable CC0 biped motion template or sample an edited clip. Optionally retarget to a reviewed Character Layers plan and return joint positions, local angles, foot contacts and reach warnings. Free local computation, no upload or provider key. Returns editable clip JSON for Motion Workbench import; does not generate artwork or render a sprite sheet. Supports idle, walk, run, jump, stab and sweep.",
      inputSchema: studySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(motionStudy(input)) }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: e instanceof Error ? e.message : "Motion study failed.",
            },
          ],
        };
      }
    },
  );
}
