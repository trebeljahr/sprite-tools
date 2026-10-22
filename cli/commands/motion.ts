import type { Command } from "commander";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { motionStudy, studySchema } from "../../src/lib/motion/study";
function json(path: string) {
  if (statSync(path).size > 1024 * 1024) throw Error("Motion input exceeds 1 MB.");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function registerMotionCommand(program: Command) {
  program
    .command("motion")
    .description(
      "Author a reusable motion template and sampled pose controls locally (no provider call).",
    )
    .option("--template <id>", "idle, walk, run, jump, stab or sweep", "walk")
    .option("--clip <file>", "custom motion clip JSON")
    .option("--plan <file>", "Character Layers plan JSON for retargeted controls")
    .option("--samples <count>", "2–64 sampled poses", Number, 12)
    .option("-o, --output <file>", "write JSON to a new file instead of stdout")
    .action((opts) => {
      try {
        const input = studySchema.parse({
          template: opts.template,
          clip: opts.clip ? json(opts.clip) : undefined,
          character_plan: opts.plan ? json(opts.plan) : undefined,
          samples: opts.samples,
        });
        const text = `${JSON.stringify(motionStudy(input), null, 2)}\n`;
        if (opts.output) writeFileSync(opts.output, text, { flag: "wx" });
        else process.stdout.write(text);
      } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : "Motion study failed."}\n`);
        process.exitCode = 1;
      }
    });
}
