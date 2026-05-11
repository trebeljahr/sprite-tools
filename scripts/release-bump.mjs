#!/usr/bin/env node
/*
 * release-bump — bump package.json + commit + tag, atomically.
 *
 * Replaces `npm version <bump> -m "..."` because doing the three steps
 * ourselves is unambiguous: bump, stage, commit, tag. release-prep.mjs
 * has already verified the working tree is clean before this runs, so
 * the commit only contains the version bump.
 *
 * Usage: node scripts/release-bump.mjs <patch|minor|major>
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const bumpKind = process.argv[2];
if (!["patch", "minor", "major"].includes(bumpKind)) {
  console.error(`release-bump: expected patch|minor|major, got ${bumpKind ?? "(nothing)"}`);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", ...opts }).trim();
}

const repoRoot = sh("git rev-parse --show-toplevel");
const pkgPath = join(repoRoot, "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const current = pkg.version;
const [maj, min, pat] = current.split(".").map((n) => Number(n) || 0);
const next =
  bumpKind === "major"
    ? `${maj + 1}.0.0`
    : bumpKind === "minor"
      ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

pkg.version = next;
// Preserve the trailing newline so diffs stay clean.
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
console.log(`  release-bump: ${current} → ${next}`);

sh(`git add ${JSON.stringify("package.json")}`, { cwd: repoRoot });
sh(`git commit -m ${JSON.stringify(`chore: release v${next}`)}`, { cwd: repoRoot });
sh(`git tag ${JSON.stringify(`v${next}`)}`, { cwd: repoRoot });
console.log(`  release-bump: committed + tagged v${next}`);
