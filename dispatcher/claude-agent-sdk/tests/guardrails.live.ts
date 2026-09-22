import { test } from "node:test";
import { assertLiveSdkOptIn, runLiveReadGuardTest } from "./live-sdk-harness.js";

// Fail before importing the runtime or creating any fixture. This file is deliberately
// outside npm test's *.test.ts glob, including when an opt-in leaks into the environment.
assertLiveSdkOptIn(process.env);

test("[live SDK] PreToolUse denies an in-cwd dotenv Read", { timeout: 60_000 }, async (t) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  await runLiveReadGuardTest(process.env, t.signal, query);
});
