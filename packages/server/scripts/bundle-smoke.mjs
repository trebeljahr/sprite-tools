// Starts the bundled server and waits for its "Listening" line. A dependency
// that fails while the bundle loads (dotenvx 2 read __filename, which an ESM
// bundle lacks) passes typecheck and unit tests and only shows here.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [entry], {
  env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const done = (code, message) => {
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (code !== 0) console.error(`${message}\n${output.slice(-2000)}`);
  process.exitCode = code;
};
const timer = setTimeout(() => done(1, "The bundled server did not start within 20 s."), 20_000);
const read = (chunk) => {
  output += chunk;
  if (output.includes("[server] Listening")) done(0);
};
child.stdout.on("data", read);
child.stderr.on("data", read);
child.on("exit", (code) => {
  if (process.exitCode === undefined)
    done(1, `The bundled server exited with code ${code} before listening.`);
});
