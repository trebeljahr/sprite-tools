import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startStudio } from "../../src/lib/video/http";

function bundledWebRoot(): string | undefined {
  // Source via tsx, compiled npm package, then an explicit repository build.
  return [
    resolve(__dirname, "../../out"),
    resolve(__dirname, "../../../out"),
    resolve(process.cwd(), "out"),
  ].find(
    (path) =>
      existsSync(resolve(path, "animate.html")) || existsSync(resolve(path, "animate/index.html")),
  );
}

export function registerStudioCommand(program: Command) {
  program
    .command("studio")
    .description(
      "Start the local video companion: encrypted BYOK setup, Web studio and MCP video processing",
    )
    .option(
      "--state-dir <path>",
      "private local video state directory (default: SPRITE_TOOLS_VIDEO_HOME or ~/.config/sprite-tools/video)",
    )
    .option("--web-root <path>", "built static Web app directory (default: bundled out/)")
    .option(
      "--port <number>",
      "loopback port (default: choose a free high port)",
      (value: string) => {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 49152 || port > 65535)
          throw new Error("Choose a port between 49152 and 65535.");
        return port;
      },
    )
    .action(async (options: { stateDir?: string; webRoot?: string; port?: number }) => {
      const studio = await startStudio({
        stateDir: options.stateDir ? resolve(options.stateDir) : undefined,
        webRoot: options.webRoot ? resolve(options.webRoot) : bundledWebRoot(),
        port: options.port,
      });
      process.stdout.write(
        `Video Studio is running locally.\nSetup: ${studio.origin}/setup#token=${studio.token}\n`,
      );
      process.stdout.write(
        "Open this private setup link in your browser. Keep this process running for Web and MCP video tools.\n",
      );
      process.stdout.write(
        "Provider keys stay in the encrypted local vault. Never paste them into an assistant conversation.\n",
      );
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        await studio.close();
      };
      process.once("SIGINT", () => {
        void stop();
      });
      process.once("SIGTERM", () => {
        void stop();
      });
    });
}
