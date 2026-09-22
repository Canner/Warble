import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { runLiveReadGuardTest, type TestQuery } from "../live-sdk-harness.js";

// A deliberately timed-out subprocess proves that node:test's signal reaches the
// harness. The query is synthetic and never imports the vendor runtime.
test("synthetic SDK timeout", { timeout: 30 }, async (t) => {
  let root = "";
  let aborted = false;
  const fake: TestQuery = async function* ({ options }) {
    root = dirname(options.cwd!);
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await new Promise<void>((_resolve, reject) => {
        options.abortController!.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("synthetic query cancelled"));
        }, { once: true });
      });
    } finally { clearInterval(keepAlive); }
  };
  try {
    await runLiveReadGuardTest({ WARBLE_RUN_LIVE_SDK_TESTS: "1", ANTHROPIC_API_KEY: "synthetic-only" }, t.signal, fake);
  } finally {
    console.log(`TIMEOUT_CLEANUP ${JSON.stringify({ aborted, removed: root !== "" && !existsSync(root) })}`);
  }
});
