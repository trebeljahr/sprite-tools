import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { runCharacter } from "../../src/lib/character/node";

export function registerCharacterCommand(program: Command) {
  program
    .command("character <input>")
    .description(
      "Prepare aligned character layers, hidden masks and joint anchors from a plan or a paid AI draft.",
    )
    .requiredOption(
      "-o, --output <directory>",
      "empty output directory, or an existing character bundle",
    )
    .option("--plan <file>", "character plan JSON (local, no provider call)")
    .option("--ai", "draft masks and joints using xAI; requires explicit paid opt-in")
    .option(
      "--bend-tests <ids>",
      "write +/-35-degree stress poses for comma-separated parts, or all",
    )
    .option("--description <text>", "character description and anatomical guidance")
    .option("--complete <ids>", "comma-separated parts, or all; generate missing hidden areas")
    .option("--completions <file>", "JSON map of part ids to aligned PNG completion files")
    .option("--allow-paid", "allow uploading the character to xAI and paying for requested steps")
    .option(
      "--max-cost-usd <amount>",
      "maximum estimated reservation for this invocation",
      Number,
      0,
    )
    .option(
      "--retry-uncertain",
      "acknowledge a previous uncertain request may already have been charged",
    )
    .action(async (input: string, opts) => {
      try {
        const result = await runCharacter(
          {
            input,
            output: opts.output,
            plan: opts.plan ? JSON.parse(readFileSync(opts.plan, "utf8")) : undefined,
            aiDraft: opts.ai,
            description: opts.description,
            bendTestParts: opts.bendTests
              ?.split(",")
              .map((s: string) => s.trim())
              .filter(Boolean),
            completeParts: opts.complete
              ?.split(",")
              .map((s: string) => s.trim())
              .filter(Boolean),
            completionPaths: opts.completions
              ? JSON.parse(readFileSync(opts.completions, "utf8"))
              : undefined,
            allowPaid: opts.allowPaid,
            maxCostUsd: opts.maxCostUsd,
            retryUncertain: opts.retryUncertain,
          },
          { apiKey: process.env.XAI_API_KEY ?? "" },
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (e) {
        process.stderr.write(
          `${e instanceof Error ? e.message : "Character layer preparation failed."}\n`,
        );
        process.exitCode = 1;
      }
    });
}
