// `pnpm dev`: the accounts server (packages/server, :3472) and `next dev`
// (:3471), which proxies /api to it the way the production Workers route does.
import { spawn } from "node:child_process";

const children = ["dev:server", "dev:client"].map((script) =>
  spawn("pnpm", ["run", script], { stdio: "inherit" }),
);
const stop = (code) => {
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
};
for (const child of children) child.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
