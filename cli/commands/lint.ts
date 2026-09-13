// `sprite-tools lint`: run the sheet linter and report structured findings.
//
// This is the command an agent should reach for first — it says what a sheet
// actually is (grid, frame count) and what is wrong with it before any other
// command commits to an interpretation. The heavy lifting all lives in
// src/lib/lint; this file is argument parsing, config assembly, rendering and
// the exit code.
//
// Exit code contract: 1 means either "error-severity findings" or "the tool
// itself failed", and the two are told apart by stdout — a lint failure still
// writes a complete report there, a tool failure writes nothing. That is why
// the exit code is set via process.exitCode rather than process.exit(): the
// report has to be flushed to a pipe before the process goes away.

import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
  addGridOptions,
  addHelpExtras,
  fail,
  type GridPaddingOpts,
  gridPaddingFromOpts,
  parseIntArg,
  writeJsonOutput,
} from "../lib/common";
import { loadPng } from "../lib/image-io";
import {
  type DeepPartial,
  type Finding,
  isRuleId,
  type LintConfig,
  type LintReport,
  lintSheet,
  RULE_DOCS,
  RULE_IDS,
  type RuleId,
  SEVERITY_ORDER,
  type Severity,
  validateRuleOption,
} from "../../src/lib/lint";

interface LintOpts extends GridPaddingOpts {
  cols?: number;
  rows?: number;
  disable: string[];
  only: string[];
  set: string[];
  severity: string;
  format: string;
  exitZero: boolean;
  output?: string;
}

export function registerLintCommand(program: Command) {
  const cmd = program
    .command("lint <input>")
    .description(
      "Lint a sprite sheet and report structured findings (grid problems, fringe, duplicates, palette noise).",
    )
    .option("--cols <n>", "columns (auto-detected if omitted)", (v) => parseIntArg("cols", v))
    .option("--rows <n>", "rows (auto-detected if omitted)", (v) => parseIntArg("rows", v))
    .option("--disable <rule>", "repeatable; also accepts a comma-separated list", collect, [])
    .option("--only <rule>", "repeatable; run only these rules", collect, [])
    .option("--set <rule.option=value>", "repeatable threshold override", collect, [])
    .option("--severity <level>", "minimum severity to report (error|warning|info)", "info")
    .option("--format <fmt>", "json | text", "json")
    .option("--exit-zero", "always exit 0, even when errors are found", false)
    .option("-o, --output <file>", "output file (default: stdout)");

  addGridOptions(cmd);

  cmd.addHelpText("after", `\n${ruleHelpLines().join("\n")}\n`);

  addHelpExtras(cmd, {
    examples: [
      "sprite-tools lint sheet.png",
      "sprite-tools lint sheet.png --format text",
      "sprite-tools lint sheet.png --cols 8 --rows 4 --severity warning",
      "sprite-tools lint tiles.png --cols 12 --rows 8 --margin 1 --spacing 2   # padded tileset",
      "sprite-tools lint sheet.png --disable duplicate-frames,non-power-of-two",
      "sprite-tools lint sheet.png --only frame-bleed --only empty-cell",
      "sprite-tools lint sheet.png --set alpha-fringe.minPixels=40 --set frame-bleed.severity=warning",
      "sprite-tools lint sheet.png | jq '.findings[] | select(.severity==\"error\")'",
    ],
    output: [
      "{ source, width, height, frameWidth, frameHeight,",
      "  grid: {cols, rows, detected, confidence,",
      "         margin: {left,top,right,bottom}, spacing: {x,y}},",
      "  summary: { errors, warnings, infos, frameCount,",
      "             rulesRun: [ruleId], rulesSkipped: [{rule, reason}] },",
      "  findings: [{ rule, severity, message,",
      "               frame|null, cell:{row,col}|null,",
      "               at:{x,y}|null, region:{x,y,width,height}|null,",
      "               data:{...} }] }",
      "",
      "  `at` and `region` are SHEET-ABSOLUTE pixel coords (unlike collision and",
      "  pivot, which are cell-relative), so an overlay can draw them directly.",
      "  Sheet-wide findings have frame and cell null. A rule can emit many",
      "  findings; a non-empty rulesSkipped is normal, not a failure.",
    ],
  });

  cmd.addHelpText("after", `\n${exitCodeHelpLines().join("\n")}\n`);

  cmd.action((input: string, opts: LintOpts) => {
    const minSeverity = parseSeverity(opts.severity);
    const format = parseFormat(opts.format);
    const only = parseRuleList("--only", opts.only);
    const disabled = parseRuleList("--disable", opts.disable);
    const overrides = parseSetList(opts.set);
    const config = buildConfig(only, disabled, overrides);

    let report: LintReport;
    try {
      report = lintSheet({ source: input, image: loadPng(input), ...gridOf(opts), config });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }

    const shown = filterBySeverity(report, minSeverity);
    if (format === "text") {
      writeTextOutput(formatTextReport(shown), opts.output);
    } else {
      writeJsonOutput(shown, opts.output);
    }

    // Never process.exit() here: stdout may still be draining into a pipe.
    if (!opts.exitZero && shown.summary.errors > 0) process.exitCode = 1;
  });
}

function gridOf(opts: LintOpts) {
  return { cols: opts.cols, rows: opts.rows, padding: gridPaddingFromOpts(opts) };
}

// ---------- option parsing ----------

function collect(v: string, prev: string[]): string[] {
  return [...prev, v];
}

function parseSeverity(raw: string): Severity {
  if (raw === "error" || raw === "warning" || raw === "info") return raw;
  fail(`--severity: expected error|warning|info, got "${raw}"`);
}

function parseFormat(raw: string): "json" | "text" {
  if (raw === "json" || raw === "text") return raw;
  fail(`--format: expected json|text, got "${raw}"`);
}

/** Accepts both repeated flags and comma-separated lists in one flag. */
function parseRuleList(flag: string, raw: string[]): RuleId[] {
  const out: RuleId[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const id = part.trim();
      if (!id) continue;
      if (!isRuleId(id)) fail(`${flag}: unknown rule "${id}" (valid: ${RULE_IDS.join(", ")})`);
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

interface OptionOverride {
  rule: RuleId;
  option: string;
  value: number | boolean | string;
}

/**
 * Every part of a `--set` is checked, not just the rule id. An unknown option
 * name would otherwise be dropped silently, and a mistyped threshold value
 * would coerce to a string, where every `<` and `>=` comparison against it is
 * false — which inverts the gate the user thought they were tuning instead of
 * disabling it. Same check the MCP server runs over its `options` record.
 */
function parseSetList(raw: string[]): OptionOverride[] {
  return raw.map((spec) => {
    const eq = spec.indexOf("=");
    if (eq < 0) fail(`--set "${spec}": expected <rule.option=value>`);
    const path = spec.slice(0, eq).trim();
    const dot = path.lastIndexOf(".");
    if (dot <= 0 || dot === path.length - 1) fail(`--set "${spec}": expected <rule.option=value>`);
    const rule = path.slice(0, dot);
    if (!isRuleId(rule)) fail(`--set: unknown rule "${rule}" (valid: ${RULE_IDS.join(", ")})`);
    const option = path.slice(dot + 1);
    const value = coerceValue(spec.slice(eq + 1).trim());
    const problem = validateRuleOption(rule, option, value);
    if (problem) fail(`--set "${spec}": ${problem}`);
    return { rule, option, value };
  });
}

/** Numbers stay numbers and true/false stay booleans; anything else is a string. */
function coerceValue(raw: string): number | boolean | string {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/**
 * --only wins first (everything else off), --disable then turns individual
 * rules off, and --set is applied last so it can re-enable or re-severity a
 * rule the earlier flags touched.
 */
function buildConfig(
  only: RuleId[],
  disabled: RuleId[],
  overrides: OptionOverride[],
): DeepPartial<LintConfig> {
  const rules: Record<string, Record<string, unknown>> = {};
  const entry = (id: RuleId) => {
    const existing = rules[id];
    if (existing) return existing;
    const created: Record<string, unknown> = {};
    rules[id] = created;
    return created;
  };

  if (only.length > 0) {
    for (const id of RULE_IDS) entry(id).enabled = only.includes(id);
  }
  for (const id of disabled) entry(id).enabled = false;
  for (const o of overrides) entry(o.rule)[o.option] = o.value;

  return { rules } as DeepPartial<LintConfig>;
}

// ---------- severity filter ----------

/**
 * Trims findings below the requested severity. `summary` keeps counting the
 * whole run, exactly as the MCP tool's min_severity does, so the two surfaces
 * emit the same JSON and a caller can see how much was held back. Errors can
 * never be filtered out, which keeps the exit code honest regardless.
 */
function filterBySeverity(report: LintReport, min: Severity): LintReport {
  if (min === "info") return report;
  const findings = report.findings.filter((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[min]);
  return { ...report, findings };
}

// ---------- text rendering ----------

function writeTextOutput(text: string, outPath?: string): void {
  if (!outPath || outPath === "-") {
    process.stdout.write(`${text}\n`);
  } else {
    writeFileSync(outPath, `${text}\n`);
  }
}

function formatTextReport(report: LintReport): string {
  const g = report.grid;
  const grid = g.detected
    ? `grid ${g.cols}x${g.rows} (detected, confidence ${g.confidence ?? "n/a"})`
    : `grid ${g.cols}x${g.rows} (explicit)`;
  const { margin: m, spacing: gap } = g;
  const padded =
    m.left || m.top || m.right || m.bottom || gap.x || gap.y
      ? `  margin ${m.left},${m.top},${m.right},${m.bottom}  spacing ${gap.x},${gap.y}`
      : "";
  const lines = [
    `${report.source}  ${report.width}x${report.height}  ${grid}${padded}  ${report.summary.frameCount} frame(s)`,
    "",
  ];

  let group: Severity | null = null;
  for (const f of report.findings) {
    // Findings arrive sorted by severity, so a change of severity is the group
    // break — one blank line, no header, keeping it one line per finding.
    if (group !== null && f.severity !== group) lines.push("");
    group = f.severity;
    lines.push(formatFinding(f));
  }
  if (report.findings.length === 0) lines.push("no findings");

  const s = report.summary;
  lines.push("");
  lines.push(
    `${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info(s) — ${report.findings.length} shown`,
  );
  for (const skip of s.rulesSkipped) lines.push(`skipped  ${skip.rule}  ${skip.reason}`);
  return lines.join("\n");
}

function formatFinding(f: Finding): string {
  const where = f.frame === null ? "sheet" : `frame ${f.frame}`;
  const cell = f.cell ? ` (${f.cell.row},${f.cell.col})` : "";
  const point = f.at ?? (f.region ? { x: f.region.x, y: f.region.y } : null);
  const at = point ? ` @ ${point.x},${point.y}` : "";
  return `${f.severity}  ${f.rule}  ${where}${cell}${at}  ${f.message}`;
}

// ---------- help text ----------

function ruleHelpLines(): string[] {
  const pad = Math.max(...RULE_IDS.map((id) => id.length)) + 2;
  const lines = ["Rules (all enabled by default, each --disable-able and --set-able):"];
  for (const id of RULE_IDS) {
    const wrapped = wrap(firstSentence(RULE_DOCS[id].summary), 74 - pad);
    lines.push(`  ${id.padEnd(pad)}${wrapped[0]}`);
    for (const rest of wrapped.slice(1)) lines.push(`  ${" ".repeat(pad)}${rest}`);
  }
  lines.push("");
  lines.push("  Every rule also states what it deliberately does not catch; the docs site");
  lines.push("  carries the full prose behind these one-line summaries.");
  return lines;
}

function exitCodeHelpLines(): string[] {
  return [
    "Exit codes:",
    "  0  no error-severity findings (or --exit-zero was passed)",
    "  1  error-severity findings present, OR the tool itself failed",
    "",
    "  Tell the two apart by stdout: a lint failure still writes a complete, valid",
    '  report there, while a tool failure writes only "sprite-tools: <msg>" to',
    "  stderr and nothing at all to stdout. The report is written before the",
    "  non-zero exit, so `sprite-tools lint sheet.png | jq` still works in CI.",
    "  Warnings and infos never fail the build on their own.",
  ];
}

function firstSentence(text: string): string {
  const match = /^[\s\S]*?\.(?=\s|$)/.exec(text);
  return match ? match[0] : text;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
