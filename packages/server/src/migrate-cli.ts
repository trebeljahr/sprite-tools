import { loadEnvironment } from "./config/env.js";
import { migrate } from "./migrate.js";

loadEnvironment();
try {
  await migrate();
  console.log("Account and budget schema ready");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
}
