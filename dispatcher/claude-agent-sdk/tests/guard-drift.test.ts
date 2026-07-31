import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { prepareDispatch, emitAgentModule } from "../src/index.js";
import { makeReadOnlyGuard as canonicalMakeReadOnlyGuard } from "../src/guardrails.js";
import type { GuardConfig } from "../src/guardrails.js";

/**
 * Drift tripwire for the standalone (eject) mode's inlined `makeReadOnlyGuard` copy
 * (`STANDALONE_HELPERS` in codegen.ts) against the canonical runtime guard (`guardrails.ts`).
 *
 * Two independent checks, both required so this test can't quietly stop meaning anything:
 *
 *   (A) BEHAVIORAL EQUIVALENCE — run both implementations against a shared input table, over the
 *       surface standalone mode actually supports: `setupScope == null`. (The `mutation`/
 *       `context_write_authz` axis is excluded from the table for a different reason — `EmittedMeta`
 *       in codegen.ts has no `mutation` field, so that axis is not reachable through codegen in
 *       EITHER emit mode; it is simply dead for this comparison, not something standalone chose to
 *       drop.) The inlined copy under test is not hand-transcribed into this file — it is extracted
 *       from a REAL generated `emit --standalone` module (a fresh temp file, dynamically imported),
 *       so this exercises the actual shipped code, not a second test-side re-transcription that could
 *       itself drift from what codegen.ts really emits.
 *
 *   (B) ONE-SIDED GROWTH — (A) alone only proves the two copies agree on the cases this file happens
 *       to enumerate; it says nothing about canonical growing NEW reachable behavior on the shared
 *       surface that the table hasn't caught up to yet (a fixed hand-written table can go stale
 *       silently and nobody notices). To close that, this file also reads guardrails.ts's own source
 *       text, mechanically strips the `setupScope`/`mutation`-gated sub-blocks (the surface standalone
 *       deliberately does not replicate), and extracts every remaining reason-text literal that reads
 *       as prose rather than a bare tool-name/property-key identifier (see `looksLikeReasonProse` —
 *       deliberately NOT a length gate; a length threshold is itself a hole, as an earlier review
 *       round demonstrated by adding a 13-char reason that a `>= 20 chars` gate let through
 *       undetected). Every extracted literal must appear among the reasons canonical actually
 *       produces when run against the table below — if canonical's restricted-surface logic gains a
 *       new denial path/reason with no corresponding CASES entry, this goes red on its own, without
 *       anyone having to remember to add a case for it.
 *
 * (B) deliberately does NOT compare byte/string content between the two *implementations* — that is
 * what (A) is for. (B) is a structural self-check of canonical ALONE (option (a) from the review:
 * "derive the table from canonical's own documented rule set and assert coverage"), used only to
 * keep the CASES table honest against canonical's own growth.
 *
 * Rejected alternative for (B): V8 precise-coverage instrumentation via `node:inspector/promises`
 * (`Profiler.startPreciseCoverage` / `takePreciseCoverage`) was prototyped first. It correctly
 * flagged untested branches, but ALSO flagged unrelated defensive/ternary fallbacks (e.g. `typeof x
 * === "string" ? x : ""`) as 0-count ranges, which would need an ever-growing hand-maintained
 * suppression list to silence — itself a new drift-prone artifact, defeating the point. Source-level
 * reason-literal extraction has no such noise: a ternary type-guard fallback contributes no
 * prose-shaped reason literal, so it never needs suppressing.
 */

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const RENDER_DEMO_IR = fileURLToPath(new URL("../../../examples/render-demo/ir.golden.json", import.meta.url));
const GUARDRAILS_SRC_PATH = fileURLToPath(new URL("../src/guardrails.ts", import.meta.url));

function opts() {
  return { signal: new AbortController().signal, toolUseID: "t1" };
}

interface ToolResult {
  behavior: "allow" | "deny";
  message?: string;
}

type CallCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  callOpts: { signal: AbortSignal; toolUseID: string },
) => Promise<ToolResult>;

interface GuardHandle {
  canUseTool: CallCanUseTool;
}

type MakeGuard = (cfg: GuardConfig) => GuardHandle;

let inlinedMakeReadOnlyGuard: MakeGuard;
let tmpDir: string | undefined;

before(async () => {
  // Any non-setup-scoped fixture works here — the cfg values used by CASES below are supplied
  // directly by this test and are independent of whatever meta the fixture's own components carry.
  // What matters is generating the REAL standalone module text and loading its actual
  // `makeReadOnlyGuard`, rather than re-typing the guard logic a second time in this test file.
  const prepared = prepareDispatch({ ir: readFileSync(RENDER_DEMO_IR, "utf8"), irPath: RENDER_DEMO_IR });
  const generated = emitAgentModule(prepared, { standalone: true });
  // Written inside the package directory, not the OS tmpdir: the generated module's bare specifier
  // `@anthropic-ai/claude-agent-sdk` resolves via Node's node_modules walk-up from the importing
  // file's own location, which only succeeds if that file lives under dispatcher/claude-agent-sdk/.
  tmpDir = mkdtempSync(join(TESTS_DIR, ".guard-drift-tmp-"));
  const modulePath = join(tmpDir, "standalone-guard.mts");
  writeFileSync(modulePath, `${generated}\nexport { makeReadOnlyGuard };\n`, "utf8");
  const mod = (await import(pathToFileURL(modulePath).href)) as { makeReadOnlyGuard: MakeGuard };
  inlinedMakeReadOnlyGuard = mod.makeReadOnlyGuard;
});

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---- (A) behavioral equivalence table -------------------------------------------------------
// `setupScope` is deliberately omitted from both configs below (undefined behaves the same as null
// for every `cfg.setupScope != null` check) — this is exactly the surface standalone mode supports;
// a setup-scoped component never reaches codegen's standalone path at all (see the wall-hit test in
// codegen.test.ts). `mutation` is omitted for the "not reachable through codegen" reason noted above.

const READONLY_CFG: GuardConfig = { readOnly: true, writeScope: null, cwd: "/proj" };
const SCOPED_CFG: GuardConfig = { readOnly: false, writeScope: "dashboards", cwd: "/proj" };

interface EquivCase {
  desc: string;
  cfg: GuardConfig;
  tool: string;
  input: Record<string, unknown>;
}

const CASES: EquivCase[] = [
  { desc: "Read: an arbitrary path is allowed", cfg: READONLY_CFG, tool: "Read", input: { file_path: "notes.txt" } },
  { desc: "Task: always allowed", cfg: READONLY_CFG, tool: "Task", input: {} },
  { desc: "TodoWrite: always allowed", cfg: READONLY_CFG, tool: "TodoWrite", input: {} },
  {
    desc: "Bash: a plain `wren` invocation is allowed",
    cfg: READONLY_CFG,
    tool: "Bash",
    input: { command: "wren --version" },
  },
  { desc: "Bash: a bare dotenv read is denied", cfg: READONLY_CFG, tool: "Bash", input: { command: "cat .env" } },
  {
    desc: "Bash: a wren-prefixed compound command hiding a dotenv read is denied (the historically-missed bypass)",
    cfg: READONLY_CFG,
    tool: "Bash",
    input: { command: "wren --version && cat .env" },
  },
  { desc: "Bash: a destructive command is denied", cfg: READONLY_CFG, tool: "Bash", input: { command: "rm -rf /" } },
  {
    desc: "Bash: shell redirection is denied",
    cfg: READONLY_CFG,
    tool: "Bash",
    input: { command: "wren query 'select 1' > out.txt" },
  },
  {
    desc: "Bash: a non-wren command is denied",
    cfg: READONLY_CFG,
    tool: "Bash",
    input: { command: "psql -c 'select 1'" },
  },
  {
    desc: "Write: no writeScope denies (read-only fallback)",
    cfg: READONLY_CFG,
    tool: "Write",
    input: { file_path: "dashboard.html" },
  },
  {
    desc: "Edit: no writeScope denies (read-only fallback)",
    cfg: READONLY_CFG,
    tool: "Edit",
    input: { file_path: "dashboard.html" },
  },
  {
    desc: "Write: inside writeScope is allowed",
    cfg: SCOPED_CFG,
    tool: "Write",
    input: { file_path: "dashboards/x.html" },
  },
  {
    desc: "Write: a sibling-prefix dir outside writeScope is denied (path-boundary check)",
    cfg: SCOPED_CFG,
    tool: "Write",
    input: { file_path: "dashboards-export/x.html" },
  },
  {
    desc: "Write: a clearly different dir outside writeScope is denied",
    cfg: SCOPED_CFG,
    tool: "Write",
    input: { file_path: "other/x.html" },
  },
  { desc: "Unknown tool: denied by the fail-closed default", cfg: READONLY_CFG, tool: "WebFetch", input: {} },
];

for (const c of CASES) {
  test(`guard-drift equivalence: ${c.desc}`, async () => {
    const canonical = (await canonicalMakeReadOnlyGuard(c.cfg).canUseTool(c.tool, c.input, opts())) as ToolResult;
    const inlined = await inlinedMakeReadOnlyGuard(c.cfg).canUseTool(c.tool, c.input, opts());
    assert.equal(inlined.behavior, canonical.behavior, `behavior mismatch for: ${c.desc}`);
    if (canonical.behavior === "deny") {
      assert.equal(inlined.message, canonical.message, `denial reason mismatch for: ${c.desc}`);
    }
  });
}

// ---- (B) one-sided-growth / coverage-completeness check --------------------------------------

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces while scanning guardrails.ts");
}

/**
 * Removes every `${guardPrefix} { ... }` block, or `${guardPrefix} singleStatement;` when the
 * guarded statement has no braces (e.g. `if (cfg.setupScope != null) return allow(input);`).
 */
function stripGuardedBlocks(text: string, guardPrefix: string): string {
  let out = text;
  let idx = out.indexOf(guardPrefix);
  while (idx >= 0) {
    let cursor = idx + guardPrefix.length;
    while (/\s/.test(out[cursor] ?? "")) cursor++;
    let endExclusive: number;
    if (out[cursor] === "{") {
      endExclusive = findMatchingBrace(out, cursor) + 1;
    } else {
      const semi = out.indexOf(";", cursor);
      if (semi < 0) throw new Error(`unterminated single-statement guard for ${guardPrefix}`);
      endExclusive = semi + 1;
    }
    out = out.slice(0, idx) + out.slice(endExclusive);
    idx = out.indexOf(guardPrefix);
  }
  return out;
}

/**
 * A candidate string/template-literal fragment reads as denial *prose* (rather than an identifier
 * used for tool-name/property-key comparison, e.g. `"Bash"`, `"file_path"`, `"command"` — or a
 * punctuation-only leftover from splitting a template literal on its `${...}` interpolations, e.g.
 * `"'."`, `"' "`) when it contains at least two distinct word-like tokens (each with 2+ letters).
 *
 * This is deliberately NOT a length gate: a length threshold is a hole by construction — any real
 * reason text shorter than the threshold walks straight through undetected, which is exactly the
 * false negative a review of this file found (a 13-char reason, `"curl blocked."`, on a new
 * canonical deny rule went completely unnoticed by CASES with the old `>= 20` gate, and all 16
 * tests still passed). `"curl blocked."` has two 2+-letter tokens ("curl", "blocked") and passes
 * this check; single-token identifiers like `"Bash"` or `"file_path"` have only one and don't.
 */
function looksLikeReasonProse(text: string): boolean {
  const wordTokens = text.split(/\s+/).filter((tok) => /[A-Za-z]{2,}/.test(tok));
  return wordTokens.length >= 2;
}

/**
 * Extract every reason-text literal reachable in canonical's `canUseTool` on the
 * `setupScope == null`, no-`mutation` surface — i.e. with the `if (cfg.setupScope != null)` and
 * `if (cfg.mutation)` gated sub-blocks stripped out first. Comments are stripped too, so prose in a
 * doc comment can't masquerade as a reason literal that CASES is required to cover. See
 * `looksLikeReasonProse` for why this has no length threshold.
 */
function extractRestrictedReasonLiterals(): Set<string> {
  const raw = readFileSync(GUARDRAILS_SRC_PATH, "utf8");
  const marker = "const canUseTool: CanUseTool = async (toolName, input) => {";
  const bodyStart = raw.indexOf(marker);
  assert.ok(bodyStart >= 0, "could not locate canUseTool's declaration in guardrails.ts (source shape changed?)");
  const braceOpen = raw.indexOf("{", bodyStart + marker.length - 1);
  const braceClose = findMatchingBrace(raw, braceOpen);
  let body = raw.slice(braceOpen, braceClose + 1);

  for (const guard of ["if (cfg.setupScope != null)", "if (cfg.mutation)"]) {
    body = stripGuardedBlocks(body, guard);
  }

  body = body.replace(/\/\/[^\n]*/g, "");

  const literals = new Set<string>();
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (looksLikeReasonProse(m[1]!)) literals.add(m[1]!);
  }
  for (const m of body.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    for (const part of m[1]!.split(/\$\{[^}]*\}/g)) {
      if (looksLikeReasonProse(part)) literals.add(part);
    }
  }
  return literals;
}

test(
  "guard-drift coverage: CASES observes every restricted-surface reason literal canonical's own " +
    "source can produce (one-sided-growth guard)",
  async () => {
    const required = extractRestrictedReasonLiterals();
    assert.ok(required.size > 0, "sanity: extraction should find at least one reason literal");

    const observed = new Set<string>();
    for (const c of CASES) {
      const result = (await canonicalMakeReadOnlyGuard(c.cfg).canUseTool(c.tool, c.input, opts())) as ToolResult;
      if (result.behavior === "deny" && result.message) observed.add(result.message);
    }
    const observedBlob = [...observed].join("\n---\n");

    const missing = [...required].filter((fragment) => !observedBlob.includes(fragment));
    assert.deepEqual(
      missing,
      [],
      "guardrails.ts's canUseTool contains restricted-surface reason text that CASES never " +
        "exercises — canonical grew new reachable behavior on the setupScope==null/no-mutation " +
        "surface. Add a CASES entry that reaches it (and update codegen.ts's inlined guard to match) " +
        "before this can pass.",
    );
  },
);
