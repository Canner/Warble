import assert from "node:assert/strict";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { parseReportArgs } from "../src/report-cli.js";

test("parses run names as positionals and an optional output pair", () => {
  const parsed = parseReportArgs(["alien-5", "alien-3", "--out", "/tmp/r.html", "--json", "/tmp/r.json"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.deepEqual(parsed.config.runs, ["alien-5", "alien-3"]);
  assert.equal(parsed.config.out, "/tmp/r.html");
  assert.equal(parsed.config.json, "/tmp/r.json");
});

test("help and version short-circuit before any run is required", () => {
  assert.equal(parseReportArgs(["--help"]).kind, "help");
  assert.equal(parseReportArgs(["-V"]).kind, "version");
});

test("naming no run is a usage error, not an empty report", () => {
  assert.throws(() => parseReportArgs([]), CliUsageError);
});

test("an unknown flag is a usage error", () => {
  assert.throws(() => parseReportArgs(["alien-5", "--nope"]), CliUsageError);
});
