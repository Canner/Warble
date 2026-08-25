import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliUsageError } from "../src/cli-usage.js";
import { parseReportArgs, readTolerant, ReportError } from "../src/report-cli.js";

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

/* -------------------------------------------------------------------------- */
/* tolerant.json: absent, malformed and empty must read differently           */
/* -------------------------------------------------------------------------- */

/**
 * `buildRunReport` scores the tolerant column whenever the verdicts are not `null`, so a malformed
 * `tolerant.json` that got coerced into `{}` would render a confident `tolerant 0/N` block
 * describing nothing. These tests exist to keep that failure impossible.
 */
async function runDirWith(contents: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "warble-tolerant-"));
  if (contents !== null) await writeFile(join(dir, "tolerant.json"), contents, "utf8");
  return dir;
}

test("a valid tolerant.json parses into the verdict map", async () => {
  const dir = await runDirWith('{"alien_1": true, "alien_2": false}');
  try {
    assert.deepEqual(await readTolerant(dir), { alien_1: true, alien_2: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absent tolerant.json is null: no autopsy has run", async () => {
  const dir = await runDirWith(null);
  try {
    assert.equal(await readTolerant(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty tolerant.json stays {} and is never downgraded to null", async () => {
  const dir = await runDirWith("{}");
  try {
    const verdicts = await readTolerant(dir);
    // An autopsy that ran and judged nothing is a real state, distinct from one that never ran.
    assert.notEqual(verdicts, null);
    assert.deepEqual(verdicts, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tolerant.json that is not a JSON object throws instead of scoring", async () => {
  for (const contents of ["[]", '"nope"', "42", "null"]) {
    const dir = await runDirWith(contents);
    try {
      await assert.rejects(
        () => readTolerant(dir),
        (error: unknown) =>
          error instanceof ReportError && /not a JSON object/.test(error.message),
        `${contents} must be rejected, not coerced`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a non-boolean verdict throws and the message names the offending key", async () => {
  const dir = await runDirWith('{"alien_1": {"passed": true}, "alien_2": false}');
  try {
    await assert.rejects(
      () => readTolerant(dir),
      (error: unknown) => {
        assert.ok(error instanceof ReportError, "must be a ReportError");
        assert.match(error.message, /alien_1/, "the message must name the offending key");
        assert.match(error.message, /not a boolean/, "the message must say what was wrong");
        assert.match(error.message, /tolerant\.json/, "the message must name the file");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unparseable tolerant.json throws rather than reading as absent", async () => {
  const dir = await runDirWith('{"alien_1": tru');
  try {
    await assert.rejects(
      () => readTolerant(dir),
      (error: unknown) => error instanceof ReportError && /not valid JSON/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
