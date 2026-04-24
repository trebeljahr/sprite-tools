import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next, widened to any depth so
    // that nested copies inside Claude Code worktrees are skipped too.
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/dist/**",
    "next-env.d.ts",
    // Claude Code worktrees live under the repo root — don't double-lint
    // them when running from the main worktree.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
