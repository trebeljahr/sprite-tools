import { writeFileSync } from "node:fs";
import {
  APP,
  ReleaseError,
  reconcileRelease,
  rollingRelease,
  safeFailure,
} from "./lib/rolling-release.mjs";

const env = (name) => (process.env[name] ?? "").trim();
try {
  if (
    env("GITHUB_REPOSITORY") !== APP.repository ||
    env("GITHUB_REF") !== `refs/heads/${APP.branch}`
  ) {
    throw new ReleaseError("Rolling deployment only runs from this repository's main workflow.");
  }
  if (!["push", "workflow_dispatch"].includes(env("GITHUB_EVENT_NAME")))
    throw new ReleaseError("Unsupported release trigger.");
  const record = (report) => {
    writeFileSync("rollout.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Release stage: ${report.stage}`);
  };
  if (env("RELEASE_OPERATION") === "reconcile") {
    if (env("GITHUB_EVENT_NAME") !== "workflow_dispatch")
      throw new ReleaseError("Reconciliation only runs when an operator dispatches it.");
    await reconcileRelease(
      {
        uuid: env("COOLIFY_RESOURCE_UUID"),
        repository: env("COOLIFY_DEPLOY_REPOSITORY"),
        actor: env("GITHUB_ACTOR"),
        token: env("GITHUB_TOKEN"),
      },
      { failedDigest: env("FAILED_DIGEST") },
      { record },
    );
  } else
    await rollingRelease(
      {
        baseUrl: env("COOLIFY_BASE_URL").replace(/\/$/, ""),
        uuid: env("COOLIFY_RESOURCE_UUID"),
        repository: env("COOLIFY_DEPLOY_REPOSITORY"),
        branch: env("COOLIFY_DEPLOY_BRANCH"),
        secret: env("COOLIFY_DEPLOY_SECRET"),
        actor: env("GITHUB_ACTOR"),
        token: env("GITHUB_TOKEN"),
        mode: env("ROLLOUT_MODE"),
      },
      {
        sha: env("TARGET_SHA"),
        digest: env("TARGET_DIGEST"),
        expectedCurrentDigest: env("EXPECTED_CURRENT_DIGEST"),
        // A dispatched `build` (deps-land.yml after it fast-forwards main)
        // releases like a push; a dispatched `deploy` needs the reviewed digest.
        automatic: env("GITHUB_EVENT_NAME") === "push" || env("RELEASE_OPERATION") === "build",
      },
      { record },
    );
} catch (error) {
  console.error(safeFailure(error));
  process.exitCode = 1;
}
