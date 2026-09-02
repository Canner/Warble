import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import * as protocol from "../src/protocol.js";
import { CANNED_USER_RESPONSE, LLM_CALL_FAILURE_LOG } from "../src/report-simulator.js";

const EXPECTED_COMMIT = "451fe2c3518ee1cf908d8139e2913483bd519381";
/**
 * The official files this adapter is a copy of, or is driven by.
 *
 * `orchestrator/runner.py` is on this list because it is the module the smoke actually executes —
 * for the oracle pass that gates every model run, and for `--concurrency`, which is the only
 * supported way to put more than one task in flight. `ainteract.py` owns per-task semantics and
 * `runner.py` owns the loop that drives them, so pinning only the first left the executed driver
 * free to move or vanish upstream with every test still green.
 */
const EXPECTED_SOURCES = [
  "system_agent/callbacks.py",
  "system_agent/tools.py",
  "system_agent/server.py",
  "user_simulator/server.py",
  "orchestrator/ainteract.py",
  "orchestrator/runner.py",
  "shared/models.py",
];
const checkout = process.env.BIRD_INTERACT_CHECKOUT;

/**
 * The mirrored file the void gate reads its two strings from, and the root the manifest sits under.
 *
 * Hardcoded rather than taken from `upstream.json`, on purpose. Deriving the gated read path from
 * the manifest would turn DELETING the entry into a skipped check instead of a failing one, which
 * is the wrong way round for a gate; the membership assertion in the pin test is what ties the two
 * together, so a manifest that drops this file breaks the build instead of quietly reading nothing.
 */
const SOURCE_ROOT = "BIRD-Interact-ADK";
const SIMULATOR_SOURCE = "user_simulator/server.py";

const readUpstreamPin = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(resolve(import.meta.dirname, "../upstream.json"), "utf8"),
  ) as Record<string, unknown>;
const EXPECTED_PATHS = {
  system_agent: {
    health: "/health",
    init_session: "/init_session",
    run_session: "/run_session",
  },
  db_environment: {
    execute: "/execute",
    schema: "/schema",
    all_column_meanings: "/all_column_meanings",
    column_meaning: "/column_meaning",
    knowledge_names: "/knowledge_names",
    knowledge: "/knowledge",
    submit: "/submit",
  },
  user_simulator: {
    ask: "/ask",
    phase_transition: "/phase_transition",
  },
};

test("upstream pin is an executable copy of the official a-interact contract", async () => {
  const pin = await readUpstreamPin();

  assert.equal(pin.repository, "https://github.com/bird-bench/BIRD-Interact.git");
  assert.equal(pin.commit, EXPECTED_COMMIT);
  assert.equal(pin.source_root, SOURCE_ROOT);
  assert.deepEqual(pin.source_paths, EXPECTED_SOURCES);
  assert.ok(
    (pin.source_paths as string[]).includes(SIMULATOR_SOURCE),
    "the file the simulator-string gate reads is no longer a declared mirrored source",
  );
  for (const path of pin.source_paths as string[]) {
    assert.equal(path.startsWith("/") || path.startsWith("BIRD-Interact-ADK/"), false);
  }
  assert.equal(pin.mode, "a-interact");
  assert.deepEqual(pin.tool_costs, protocol.TOOL_COSTS);
  assert.deepEqual(pin.http_paths, EXPECTED_PATHS);
  assert.deepEqual(pin.service_ports, {
    system_agent: 6000,
    user_simulator: 6001,
    db_environment: 6002,
  });
  assert.equal(pin.initial_budget_formula_version, "adk-ainteract-v1");
  assert.equal(
    pin.mode,
    (protocol as unknown as Record<string, unknown>).BIRD_INTERACT_MODE,
  );
  assert.deepEqual(
    pin.http_paths,
    (protocol as unknown as Record<string, unknown>).BIRD_HTTP_PATHS,
  );
  assert.deepEqual(
    pin.service_ports,
    (protocol as unknown as Record<string, unknown>).BIRD_SERVICE_PORTS,
  );
  assert.equal(
    pin.initial_budget_formula_version,
    (protocol as unknown as Record<string, unknown>).INITIAL_BUDGET_FORMULA_VERSION,
  );
  assert.equal(
    protocol.calculateInitialBudget({ critical: 2, knowledge: 1, patience: 3 }),
    18,
  );
});
/**
 * Python string prefixes this reader knows, so `f"..."` is never mistaken for a plain literal.
 *
 * `f` and `b` are listed to be RECOGNISED, not to be evaluated: both are read to their closing
 * quote and then reported as unreadable, because an f-string's value is decided at runtime and a
 * bytes literal is not a `str` at all. Refusing to guess is the safe direction — see
 * `pythonReturnedStrings`.
 */
const PYTHON_STRING_PREFIXES = new Set(["", "b", "br", "f", "fr", "r", "rb", "rf", "u"]);

/** Backslash escapes whose value is unambiguous. `"\n"` is the line continuation, not a newline. */
const PYTHON_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "\n": "",
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

interface PythonLiteral {
  /** The literal's exact value, or `undefined` when this reader declines to evaluate it. */
  readonly value: string | undefined;
  /**
   * The runs of text the literal contributes verbatim, split wherever it stops being knowable.
   *
   * An f-string placeholder and an escape this reader cannot decode are both boundaries, so a
   * phrase found inside ONE segment is guaranteed to appear contiguously in the produced string.
   * Joining them instead would invent adjacencies: `f"LLM call {stage} failed"` never produces
   * `LLM call failed`, and a pin that concatenated its segments would say it does.
   */
  readonly segments: readonly string[];
  /** Index just past the closing quote, so scanning resumes outside the literal. */
  readonly next: number;
}

/**
 * Reads the Python string literal at `from`, or returns `undefined` when there is not one there.
 *
 * Scanning literals is what keeps the walker honest about everything else: a `#` inside a string is
 * not a comment and the word `return` inside a docstring is not a statement, so the only way to
 * find real `return`s is to step over real strings first.
 *
 * f-strings are read for their `segments` but never for their `value` — the canned reply has to be
 * a value this reader is sure of, while the failure log only has to contain a phrase.
 */
function readPythonStringLiteral(source: string, from: number): PythonLiteral | undefined {
  let open = from;
  while (open < source.length && /[A-Za-z]/.test(source.charAt(open))) open += 1;
  const prefix = source.slice(from, open).toLowerCase();
  const quote = source.startsWith('"""', open)
    ? '"""'
    : source.startsWith("'''", open)
      ? "'''"
      : source.charAt(open) === '"' || source.charAt(open) === "'"
        ? source.charAt(open)
        : undefined;
  if (quote === undefined || !PYTHON_STRING_PREFIXES.has(prefix)) return undefined;

  const raw = prefix.includes("r");
  const formatted = prefix.includes("f");
  const bytes = prefix.includes("b");
  const segments: string[] = [];
  let exact = !formatted && !bytes;
  let current = "";
  let i = open + quote.length;
  const breakSegment = (): void => {
    segments.push(current);
    current = "";
    exact = false;
  };
  while (i < source.length) {
    if (source.startsWith(quote, i)) {
      const value = exact ? current : undefined;
      segments.push(current);
      return { value, segments: bytes ? [] : segments, next: i + quote.length };
    }
    if (source.charAt(i) === "\\" && i + 1 < source.length) {
      const escape = source.charAt(i + 1);
      const decoded = PYTHON_ESCAPES[escape];
      if (raw) current += source.charAt(i) + escape;
      else if (decoded !== undefined) current += decoded;
      else breakSegment();
      i += 2;
      continue;
    }
    if (formatted && source.charAt(i) === "{") {
      if (source.charAt(i + 1) === "{") {
        current += "{";
        i += 2;
        continue;
      }
      let braces = 1;
      i += 1;
      while (i < source.length && braces > 0 && !source.startsWith(quote, i)) {
        if (source.charAt(i) === "{") braces += 1;
        else if (source.charAt(i) === "}") braces -= 1;
        i += 1;
      }
      breakSegment();
      continue;
    }
    if (formatted && source.charAt(i) === "}" && source.charAt(i + 1) === "}") {
      current += "}";
      i += 2;
      continue;
    }
    if (source.charAt(i) === "\n" && quote.length === 1) break;
    current += source.charAt(i);
    i += 1;
  }
  return { value: undefined, segments: [], next: i };
}

interface ReturnedExpression {
  /** The returned value, or `undefined` when the expression is not literals alone. */
  readonly value: string | undefined;
  readonly next: number;
}

/**
 * Reads a returned expression, but only while it stays string literals and parentheses.
 *
 * Python joins adjacent literals with no operator, so the chain — not the single literal — is the
 * unit that carries the value: `("a" "b")` returns `"ab"`. Whitespace, line breaks inside the
 * parentheses, backslash continuations and a trailing comment are all consumed because none of them
 * changes what is returned. Anything else at all — a name, a `+`, a call, a format — ends the read
 * as unreadable, and unreadable fails the pin.
 */
function readReturnedLiteralChain(source: string, from: number): ReturnedExpression {
  let i = from;
  let depth = 0;
  let literals = 0;
  let readable = true;
  let value = "";
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === "\\" && source.charAt(i + 1) === "\n") {
      i += 2;
    } else if (char === "\n") {
      if (depth === 0) break;
      i += 1;
    } else if (char === " " || char === "\t" || char === "\r") {
      i += 1;
    } else if (char === "#") {
      while (i < source.length && source.charAt(i) !== "\n") i += 1;
    } else if (char === "(") {
      depth += 1;
      i += 1;
    } else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
    } else {
      const literal = readPythonStringLiteral(source, i);
      if (literal === undefined) {
        readable = false;
        break;
      }
      literals += 1;
      if (literal.value === undefined) readable = false;
      else value += literal.value;
      i = literal.next;
    }
  }
  const complete = readable && literals > 0 && depth === 0;
  return { value: complete ? value : undefined, next: i };
}

/** Whether only blank space separates `at` from the start of its line. */
function startsStatement(source: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const char = source.charAt(i);
    if (char === "\n") return true;
    if (char !== " " && char !== "\t" && char !== "\r") return false;
  }
  return true;
}

/** Whether only blank space or a comment separates `at` from the end of its line. */
function endsStatement(source: string, at: number): boolean {
  for (let i = at; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (char === "\n" || char === "#") return true;
    if (char !== " " && char !== "\t" && char !== "\r") return false;
  }
  return true;
}

interface PythonStrings {
  /** Values a `return` yields, for the returns whose whole expression is literals. */
  readonly returned: readonly string[];
  /** Verbatim text runs of every literal that is evaluated as more than a discarded statement. */
  readonly evaluated: readonly string[];
}

/**
 * What `source` produces, read straight off the page: values it returns, and text it evaluates.
 *
 * `returned` closes the bypass that keeps the literal and moves the change outside it:
 *
 * ```python
 * CANNED = "I'm not sure I understand your question."
 * return CANNED + " Could you rephrase?"
 * ```
 *
 * The file still contains the pinned sentence, so a substring or whole-literal pin passes, while
 * the simulator now answers something the runtime's `===` will never match — a broken simulator
 * grading `healthy` and publishing its scores, measured. Asking what the file RETURNS instead of
 * what it CONTAINS is what closes that: a `return` is evaluated only when the whole expression is
 * literals, and every other shape is reported as no returned value at all. That trades a false pass
 * for a false alarm, which is the right way round — an upstream that puts the canned reply behind
 * indirection is exactly the upstream a human has to re-read before the gate is trusted again,
 * because indirection is how the value moves while the literal stays put.
 *
 * `evaluated` closes the same class on the failure log, where the runtime counts a SUBSTRING of the
 * simulator's log file rather than matching a value. Containment was too weak there for a quieter
 * reason: a rewording that leaves the old phrase behind in a comment or a docstring keeps the pin
 * green while the reworded line writes something the count never sees, and a count of zero is a
 * broken simulator grading healthy. A comment is never evaluated, and a string that is a statement
 * all by itself is evaluated and discarded — a docstring is the familiar case, but any bare string
 * is the same dead expression — so neither can be what reaches the log. Every other literal counts,
 * whatever names the call around it uses: `logger.error`, `log.exception`, a helper, an `%`-format
 * or a message assigned to a constant first all keep working, which is why this is pinned to being
 * evaluated at all rather than to a logging call by name. The one shape it cannot see is a literal
 * that is evaluated but never actually logged.
 */
function readPythonStrings(source: string): PythonStrings {
  const returned: string[] = [];
  const evaluated: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === "#") {
      while (i < source.length && source.charAt(i) !== "\n") i += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    const literal = readPythonStringLiteral(source, i);
    if (literal !== undefined) {
      const discarded =
        depth === 0 && startsStatement(source, i) && endsStatement(source, literal.next);
      if (!discarded) evaluated.push(...literal.segments);
      i = literal.next;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let word = i;
      while (word < source.length && /[A-Za-z0-9_]/.test(source.charAt(word))) word += 1;
      if (source.slice(i, word) === "return" && source.charAt(i - 1) !== ".") {
        const chain = readReturnedLiteralChain(source, word);
        if (chain.value !== undefined) returned.push(chain.value);
      }
      // Resume just past the keyword rather than past the expression, so the literals inside it are
      // still scanned for `evaluated` and the bracket depth stays truthful for the ones after it.
      i = word;
      continue;
    }
    i += 1;
  }
  return { returned, evaluated };
}

/**
 * Holds the two gate strings against the official source they were copied from.
 *
 * Both are asked what the file DOES, not what it contains, because containment is what let a
 * value-changing upstream through at both ends. Shared by the gated test and by `UPSTREAM_MATRIX`
 * below, so the discrimination the matrix proves is the discrimination the real checkout is
 * actually held to — a matrix that exercised its own copy of the rule would only pin the copy to
 * itself.
 */
function assertOfficialSimulatorStrings(server: string): void {
  const strings = readPythonStrings(server);
  assert.ok(
    strings.returned.includes(CANNED_USER_RESPONSE),
    "user_simulator/server.py no longer returns this exact canned non-answer",
  );
  assert.ok(
    strings.evaluated.some((text) => text.includes(LLM_CALL_FAILURE_LOG)),
    "user_simulator/server.py no longer logs this exact LLM failure line",
  );
}

/**
 * The two strings the void gate is decided by, held against the file they were copied from.
 *
 * `CANNED_USER_RESPONSE` is compared exactly and `LLM_CALL_FAILURE_LOG` is counted as a substring,
 * so an upstream rewording of either disarms the gate in silence: a broken simulator's canned
 * replies count as real answers, no LLM failure is counted, and the run grades `healthy` and
 * publishes scores the benchmark cannot stand behind — with every test still green. Neither string
 * can be pinned from inside this package, which agrees with any wording it holds; the benchmark's
 * own code is the only authority, exactly as it is for `OFFICIAL_USER_SIM_MODEL`.
 *
 * Both are held to what the file DOES, never to what it contains, because containment let a
 * value-changing upstream through at each end. The canned reply is held to what the file RETURNS:
 * containment of even the whole quoted literal was not enough, since `CANNED = "<the sentence>"`
 * followed by `return CANNED + " Could you rephrase?"` leaves the literal untouched while the
 * simulator answers something the runtime's `===` never matches — five canned replies measured
 * `{"cannedResponses":0,"verdict":"healthy"}` instead of `void`. The failure line is held to text
 * the file EVALUATES, because a rewording that leaves the old phrase behind in a comment or a
 * docstring keeps a containment pin green while the reworded call writes something the substring
 * count never sees, and a count of zero is that same broken simulator grading healthy.
 *
 * `readPythonStrings` answers both questions, and `UPSTREAM_MATRIX` below is the evidence that it
 * tells the value-changing rewrites apart from the cosmetic ones at both ends.
 */
test(
  "the simulator's canned reply and failure log line are read from the pinned checkout",
  { skip: checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to pin the simulator strings" : false },
  async () => {
    assert.ok(checkout);
    assertOfficialSimulatorStrings(
      await readFile(join(checkout, SOURCE_ROOT, SIMULATOR_SOURCE), "utf8"),
    );
  },
);

/**
 * `source_paths` held against the checkout instead of against a copy of itself.
 *
 * The list and `EXPECTED_SOURCES` pin each other, which proves only that someone edited both files
 * — nothing has ever read it against the benchmark, so the entry was documentation while the
 * hardcoded read path did the work. That left the drift mode it exists to describe undetected:
 * upstream MOVING or DELETING a mirrored file changes what this adapter is a copy of, and five of
 * these six could vanish today with every test still green. Statting each entry is what makes the
 * list a manifest rather than a comment.
 */
test(
  "every mirrored source path in the pin exists in the checkout",
  {
    skip:
      checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to verify the source manifest" : false,
  },
  async () => {
    assert.ok(checkout);
    const pin = await readUpstreamPin();
    for (const path of pin.source_paths as string[]) {
      const mirrored = await stat(join(checkout, SOURCE_ROOT, path)).catch(() => undefined);
      assert.ok(mirrored?.isFile(), `${path} is no longer a file in the pinned checkout`);
    }
  },
);

/**
 * The canned reply, spelled the way the official file spells it today.
 *
 * The matrix below mutates THIS line, so it has to stay byte-identical to
 * `BIRD-Interact-ADK/user_simulator/server.py:119`; the gated test above is what proves it still is.
 */
const CANNED_RETURN = `    return "I'm not sure I understand your question."`;

/**
 * The failure log call, spelled the way the official file spells it today.
 *
 * Byte-identical to `BIRD-Interact-ADK/user_simulator/server.py:75`, where the phrase sits inside
 * an f-string argument — so the pin has to read f-strings, which the canned side deliberately
 * refuses to evaluate.
 */
const FAILURE_LOG_CALL = `        logger.error(f"LLM call failed: {e}")`;

/**
 * The shape of the official fallback path, reduced to what the pin has to reason about.
 *
 * Both decoys are load-bearing. `return content.split("</s>")[0].strip()` is a return whose
 * expression merely CONTAINS a literal, and `return ""` is a return of a literal that is not this
 * one — a reader that answered "the file returns a string somewhere" would pass on both.
 */
const OFFICIAL_SIMULATOR = [
  "def _call_llm(prompt: str, max_tokens: int) -> str:",
  "    try:",
  "        return _client.completion(prompt, temperature=0).content",
  "    except Exception as e:",
  FAILURE_LOG_CALL,
  '        return ""',
  "",
  "",
  "def _generate_response(state, question: str, action: str) -> str:",
  "    content = _call_llm(prompt, max_tokens=1024)",
  '    if "</s>" in content:',
  '        return content.split("</s>")[0].strip()',
  CANNED_RETURN,
  "",
].join("\n");

const rewriteCannedReturn = (replacement: string): string =>
  OFFICIAL_SIMULATOR.replace(CANNED_RETURN, replacement);

const rewriteFailureLog = (replacement: string): string =>
  OFFICIAL_SIMULATOR.replace(FAILURE_LOG_CALL, replacement);

/**
 * Upstreams this pin has to tell apart, and the answer it owes for each.
 *
 * `accepted` is not a taste call: it is whether the VALUE `_generate_response` falls back to is
 * still `CANNED_USER_RESPONSE`, which is the only thing the runtime's `===` cares about. Every row
 * was checked against `ast.literal_eval` on a real synthetic checkout before it was written down.
 */
const UPSTREAM_MATRIX: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly accepted: boolean;
  readonly why: string;
}> = [
  {
    name: "faithful",
    source: OFFICIAL_SIMULATOR,
    accepted: true,
    why: "the official file, unchanged",
  },
  {
    name: "canned reworded",
    source: rewriteCannedReturn(`    return "Sorry, I could not follow that question."`),
    accepted: false,
    why: "a different sentence is a different value",
  },
  {
    name: "canned appended inside the literal",
    source: rewriteCannedReturn(
      `    return "I'm not sure I understand your question. Could you rephrase?"`,
    ),
    accepted: false,
    why: "the old sentence is still a substring, but no longer the whole value",
  },
  {
    name: "canned appended by concatenation",
    source: rewriteCannedReturn(
      [
        `    CANNED = "I'm not sure I understand your question."`,
        `    return CANNED + " Could you rephrase?"`,
      ].join("\n"),
    ),
    accepted: false,
    why: "the literal survives verbatim while the returned value does not",
  },
  {
    name: "canned appended by adjacent literals",
    source: rewriteCannedReturn(
      [
        "    return (",
        `        "I'm not sure I understand your question."`,
        `        " Could you rephrase?"`,
        "    )",
      ].join("\n"),
    ),
    accepted: false,
    why: "Python concatenates adjacent literals, so this changes the value with no operator at all",
  },
  {
    name: "canned requoted",
    source: rewriteCannedReturn(`    return 'I\\'m not sure I understand your question.'`),
    accepted: true,
    why: "escaping the apostrophe to switch quote style leaves the value identical",
  },
  {
    name: "canned reformatted",
    source: rewriteCannedReturn(
      [
        "    return  (",
        `        "I'm not sure I understand your question."`,
        "    )  # canned fallback",
      ].join("\n"),
    ),
    accepted: true,
    why: "parentheses, a line break, padding and a trailing comment change no value",
  },
  {
    name: "canned behind an f-string",
    source: rewriteCannedReturn(`    return f"I'm not sure I understand your question."`),
    accepted: false,
    why: "a deliberate false alarm: an f-string is interpolation, and the reader will not guess",
  },
  {
    name: "canned surviving only in a docstring",
    source: rewriteCannedReturn(`    return "Sorry, I could not follow that question."`).replace(
      "def _generate_response(state, question: str, action: str) -> str:",
      [
        "def _generate_response(state, question: str, action: str) -> str:",
        `    """Was: return "I'm not sure I understand your question." before the rewrite."""`,
      ].join("\n"),
    ),
    accepted: false,
    why: "a sentence quoted in prose is not a sentence the simulator ever answers with",
  },
  {
    name: "canned surviving only in a comment",
    source: rewriteCannedReturn(
      [
        `    # was: return "I'm not sure I understand your question."`,
        `    return "Sorry, I could not follow that question."`,
      ].join("\n"),
    ),
    accepted: false,
    why: "a sentence in a comment is not a sentence the simulator ever answers with",
  },
  {
    name: "failure log reworded",
    source: OFFICIAL_SIMULATOR.replace("LLM call failed", "LLM request errored"),
    accepted: false,
    why: "the counted substring is gone, so every failure would count as zero",
  },
  {
    name: "failure log surviving only in a docstring",
    source: rewriteFailureLog(
      [
        `        logger.error(f"LLM request errored: {e}")`,
        `        """Renamed from "LLM call failed" in the logging pass."""`,
      ].join("\n"),
    ),
    accepted: false,
    why: "a discarded string statement is never written to the log the count is taken from",
  },
  {
    name: "failure log surviving only in a comment",
    source: rewriteFailureLog(
      [
        `        logger.error(f"LLM request errored: {e}")`,
        "        # was: LLM call failed",
      ].join("\n"),
    ),
    accepted: false,
    why: "a comment is never written to the log the count is taken from",
  },
  {
    name: "failure log reformatted across lines",
    source: rewriteFailureLog(
      [
        "        logger.error(",
        `            f"LLM call failed: {e}",  # keep the wording, the report counts it`,
        "        )",
      ].join("\n"),
    ),
    accepted: true,
    why: "wrapping the call changes nothing about the text that reaches the log",
  },
  {
    name: "failure log switched to percent formatting",
    source: rewriteFailureLog(`        logger.error("LLM call failed: %s", e)`),
    accepted: true,
    why: "a different interpolation style still logs the phrase the count splits on",
  },
  {
    name: "failure log broken by a placeholder",
    source: rewriteFailureLog(`        logger.error(f"LLM call {stage} failed: {e}")`),
    accepted: false,
    why: "the phrase never reaches the log contiguously, so the count would be zero",
  },
];

for (const { name, source, accepted, why } of UPSTREAM_MATRIX) {
  test(`upstream pin ${accepted ? "accepts" : "rejects"}: ${name}`, () => {
    if (accepted) {
      assert.doesNotThrow(() => assertOfficialSimulatorStrings(source), why);
      return;
    }
    assert.throws(() => assertOfficialSimulatorStrings(source), assert.AssertionError, why);
  });
}

// ---------------------------------------------------------------------------
// The two-stage `/ask` pipeline the `void`-on-any-LLM-failure rule is derived from.
// ---------------------------------------------------------------------------

/**
 * Upstream files this pin READS as facts, rather than mirrors as sources.
 *
 * Neither belongs in `upstream.json`'s `source_paths`, and neither is there: that list is what this
 * adapter is a COPY of, and nothing here is copied from either file. They are read for the premises
 * `assessSimulator`'s comment argues from — the retry budget the simulator's calls are given, and
 * the action space stage 1 chooses in. The paths are hardcoded for the same reason `SIMULATOR_SOURCE`
 * is: a file that moves or vanishes upstream then fails the read, where a path derived from a
 * manifest would turn the same drift into a check that quietly read nothing.
 */
const RETRY_SOURCE = "shared/llm.py";
const PROMPTS_SOURCE = "user_simulator/prompts.py";

/**
 * How every failure below says what it is really reporting.
 *
 * These assertions are not pinning upstream for its own sake. Each one is a PREMISE of the argument
 * written into `assessSimulator`'s doc comment, which is the only defence the `void`-on-any-failure
 * rule has — the rule withholds every score from a run whose other answers look real, and the
 * reviewer's objection to it ("nine good answers and one transient blip should be `degraded`") is
 * refused on facts that live entirely in another repository. A premise that stops holding does not
 * announce itself: the comment keeps making its case, the tests keep passing, and the rule is either
 * over-strict or unsound with nothing on the page saying which. So a failure here has to hand the
 * reader the premise, the consequence, and the instruction to re-derive rather than to re-baseline.
 */
const because = (found: string, consequence: string): string =>
  [
    `${found} —`,
    "the `void`-on-any-LLM-failure rule in src/report-simulator.ts is derived from this shape, and",
    `${consequence}.`,
    "Re-derive that rule against the changed upstream before trusting the verdict again.",
  ].join(" ");

interface PythonSplit {
  /** The file, verbatim. */
  readonly source: string;
  /** `source` with every comment and string literal blanked to spaces, newlines kept in place. */
  readonly code: string;
  /** Verbatim text runs of every string literal, whether or not the literal is ever evaluated. */
  readonly text: readonly string[];
}

/**
 * Separates what a Python file EXECUTES from what it merely says, keeping every offset.
 *
 * The structural pins below all ask questions of the form "is there an `if` here", "how many
 * `return`s does this function have", "does this call still receive `num_retries`" — and every one
 * of them is a lie if asked of raw text, because `# if not action: return CANNED` and a docstring
 * quoting an old implementation both answer yes. Blanking comments and literals to spaces rather
 * than deleting them keeps line numbers, indentation and bracket columns intact, so indentation-
 * based structure reading stays truthful on the masked view.
 *
 * `text` is the complement, for the two questions that ARE about what the file says: which prompt
 * slots a stage substitutes into its template, and whether stage 1's action space still has the
 * three actions the comment names. Literal segments are kept unjoined for the reason
 * `PythonLiteral.segments` explains — joining across an f-string placeholder invents adjacencies.
 */
function splitPythonSource(source: string): PythonSplit {
  const code = source.split("");
  const text: string[] = [];
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j += 1) if (code[j] !== "\n") code[j] = " ";
  };
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === "#") {
      const line = source.indexOf("\n", i);
      const end = line === -1 ? source.length : line;
      blank(i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z_'"]/.test(char)) {
      // Tried at every identifier start, not only at a quote, so a prefixed literal is read as the
      // literal it is: `f"…"` opens a string, while `format(…)` is a name that merely starts with f.
      const literal = readPythonStringLiteral(source, i);
      if (literal !== undefined) {
        text.push(...literal.segments);
        blank(i, literal.next);
        i = literal.next;
        continue;
      }
      if (/[A-Za-z_]/.test(char)) {
        while (i < source.length && /[A-Za-z0-9_]/.test(source.charAt(i))) i += 1;
        continue;
      }
    }
    i += 1;
  }
  return { source, code: code.join(""), text };
}

interface PythonFunction {
  /** The body, verbatim, for the value questions `readPythonStrings` answers. */
  readonly source: string;
  /** The body with comments and literals blanked, for the structural questions. */
  readonly code: string;
  /** Indentation of the body's own statements, so a nested `return` is distinguishable. */
  readonly indent: number;
  /** Every non-blank masked line of the body: a masked docstring line reads as blank. */
  readonly lines: readonly { readonly indent: number; readonly text: string }[];
}

/**
 * The body of `def name(...)`, or `undefined` when the file no longer defines it.
 *
 * Deliberately returns `undefined` rather than throwing, so the caller names the function it was
 * looking for in the failure. A function that has vanished upstream is the loudest drift there is
 * and has to read as a finding about the pipeline, not as a `TypeError` in the reader.
 */
function readPythonFunction(module: PythonSplit, name: string): PythonFunction | undefined {
  const header = new RegExp(`^([ \\t]*)(?:async[ \\t]+)?def[ \\t]+${name}[ \\t]*\\(`, "m").exec(
    module.code,
  );
  if (header === null) return undefined;
  const indent = (header[1] ?? "").length;

  // The signature may wrap, so its end is the first newline at bracket depth zero, not the first
  // newline. Literals are already blanked, so no quote inside a default value can confuse the walk.
  let i = header.index + header[0].length - 1;
  let depth = 0;
  while (i < module.code.length) {
    const char = module.code.charAt(i);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "\n" && depth === 0) break;
    i += 1;
  }

  const start = i + 1;
  let end = module.code.length;
  const lines: { indent: number; text: string }[] = [];
  let cursor = start;
  while (cursor < module.code.length) {
    const break_ = module.code.indexOf("\n", cursor);
    const stop = break_ === -1 ? module.code.length : break_;
    const line = module.code.slice(cursor, stop);
    const trimmed = line.trim();
    if (trimmed !== "") {
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) {
        end = cursor;
        break;
      }
      lines.push({ indent: lineIndent, text: trimmed });
    }
    cursor = stop + 1;
  }
  return {
    source: module.source.slice(start, end),
    code: module.code.slice(start, end),
    indent: lines.length === 0 ? indent + 4 : Math.min(...lines.map((line) => line.indent)),
    lines,
  };
}

/** How many times `word` occurs as a whole token of executed code. */
const countWord = (code: string, word: string): number =>
  (code.match(new RegExp(`\\b${word}\\b`, "g")) ?? []).length;

/** How many times `name` is CALLED. `_call_llm(` is not counted for `call_llm`, and vice versa. */
const countCall = (code: string, name: string): number =>
  (code.match(new RegExp(`\\b${name}[ \\t]*\\(`, "g")) ?? []).length;

/** How many times `name` is assigned. `x == y` and `x["k"] = v` are not assignments to `x`. */
const countAssignments = (code: string, name: string): number =>
  (code.match(new RegExp(`\\b${name}[ \\t]*=(?!=)`, "g")) ?? []).length;

/** The `return` statements of a body, as `{ indent, expression }`. */
const returnsOf = (fn: PythonFunction): ReadonlyArray<{ indent: number; expression: string }> =>
  fn.lines
    .filter((line) => /^return\b/.test(line.text))
    .map((line) => ({ indent: line.indent, expression: line.text.slice("return".length).trim() }));

/**
 * The two-stage `/ask` pipeline, held against the file the `void` rule was derived from.
 *
 * `assessSimulator` voids a run on ANY logged LLM failure, refusing the intuitive reading in which
 * one failure beside nine real answers is `degraded`. The refusal is not a taste call; it is an
 * argument about this pipeline, and these are its premises:
 *
 * - **One `/ask` spends TWO LLM calls**, one per stage. That is what makes "ten asks, nine answers,
 *   one failure" the wrong arithmetic: there is no missing tenth answer, so `unanswered` is 0.
 * - **A stage-1 failure does not short-circuit.** `_call_llm` swallows the exception into `""`,
 *   `_parse_action` returns that as a blank action WITHOUT raising, and `_ask_sync` runs
 *   `_generate_response` on it anyway — producing an ordinary `<s>…</s>` answer that is neither
 *   canned nor missing. `cannedResponses + unanswered` is 0 and the run reads `healthy`.
 * - **A stage-2 failure IS visible**, as the canned reply `cannedResponses` already counts. The
 *   asymmetry between the two stages is the whole reason `llmCallFailures` has to be its own gate:
 *   it is the ONLY evidence the first case leaves behind.
 * - **The blank action is not inert.** Stage 2's prompt carries the ground-truth SQL and the clear
 *   query and is steered by the action slot, so blanking that slot is over- or under-disclosure
 *   written into the trace as an unremarkable turn — and counted here as a real answer.
 *
 * Every one of those is a fact about a file in another repository, and every one of them can stop
 * being true with this package's tests still green. Shared by the gated test and by
 * `PIPELINE_MATRIX`, so the structure the matrix proves the reader can discriminate is the structure
 * the real checkout is held to — a matrix run against its own copy of the rule pins only the copy.
 */
function assertOfficialAskPipeline(server: string): void {
  const module = splitPythonSource(server);
  const fn = (name: string): PythonFunction => {
    const found = readPythonFunction(module, name);
    assert.ok(
      found,
      because(
        `user_simulator/server.py no longer defines ${name}()`,
        "a restructured /ask pipeline decides afresh which LLM failures `cannedResponses` and " +
          "`unanswered` can still see, and which are left with `llmCallFailures` as their only trace",
      ),
    );
    return found;
  };
  const callLlm = fn("_call_llm");
  const parseAction = fn("_parse_action");
  const generateResponse = fn("_generate_response");
  const askSync = fn("_ask_sync");
  const endpoint = fn("ask_user");

  // Premise: the endpoint the adapter's `ask_user` tool hits is the two-stage pipeline. Without
  // this, everything below is true of a function nothing calls.
  assert.ok(
    countWord(endpoint.code, "_ask_sync") > 0,
    because(
      "the /ask endpoint no longer runs _ask_sync",
      "the calls a charged `ask_user` actually spends are no longer the ones counted below, so the " +
        "failure-to-ask ratio the rule reasons about is unknown",
    ),
  );

  // Premise: one ask spends exactly two LLM calls, one per stage.
  assert.equal(
    countCall(askSync.code, "_parse_action"),
    1,
    because(
      "_ask_sync no longer runs stage 1 exactly once",
      "`degraded` would become the right verdict for a single failure only if a failure could no " +
        "longer land in an invisible stage, and a changed stage count is exactly what decides that",
    ),
  );
  assert.equal(
    countCall(askSync.code, "_generate_response"),
    1,
    because(
      "_ask_sync no longer runs stage 2 exactly once",
      "the canned reply that makes a stage-2 failure visible to `cannedResponses` is stage 2's " +
        "fallback, so a second or absent stage-2 call changes what a single logged failure means",
    ),
  );
  for (const [stage, body] of [
    ["stage 1 (_parse_action)", parseAction],
    ["stage 2 (_generate_response)", generateResponse],
  ] as const) {
    assert.equal(
      countCall(body.code, "_call_llm"),
      1,
      because(
        `${stage} no longer spends exactly one LLM call`,
        "the comment in report-simulator.ts states that one /ask spends TWO calls, and that count " +
          "is what makes `ten asks, nine real answers, one failure` an arithmetic with no missing " +
          "tenth answer rather than one with a hole in it",
      ),
    );
  }

  // Premise: `_call_llm` turns a failed call into a VALUE, and leaves the counted line behind.
  assert.deepEqual(
    readPythonStrings(callLlm.source).returned,
    [""],
    because(
      "_call_llm no longer falls back to the empty string, and only to it",
      "returning anything else — or propagating the exception, which would surface the ask as an " +
        "HTTP error that `attempts > answered` already catches — is what decides whether a stage-1 " +
        "failure is silent at all",
    ),
  );
  assert.equal(
    countWord(callLlm.code, "raise"),
    0,
    because(
      "_call_llm now re-raises a failed call",
      "a raised stage-1 failure reaches the runtime as an errored ask, which the attempted-ask " +
        "denominator already reports, and `llmCallFailures` stops being the only evidence of it",
    ),
  );
  assert.ok(
    readPythonStrings(callLlm.source).evaluated.some((run) => run.includes(LLM_CALL_FAILURE_LOG)),
    because(
      "the counted failure line is no longer logged by _call_llm itself",
      "`llmCallFailures` counts that phrase in the simulator's log, and a phrase written somewhere " +
        "other than the swallowing `except` no longer stands one-for-one with a swallowed call",
    ),
  );
  assert.equal(
    countWord(callLlm.code, "for") + countWord(callLlm.code, "while"),
    0,
    because(
      "_call_llm now retries on its own",
      "the comment argues that one logged line means every attempt failed, on the strength of the " +
        "retry budget in shared/llm.py alone; a second retry layer here changes what one line means",
    ),
  );
  assert.ok(
    countCall(callLlm.code, "call_llm") > 0 && /\bshared[ \t]*\.[ \t]*llm\b/.test(callLlm.code),
    because(
      "_call_llm no longer routes through shared.llm.call_llm",
      "the retry budget pinned from shared/llm.py is only the simulator's budget while the " +
        "simulator's calls still go through that function",
    ),
  );

  // Premise: a blank action does NOT short-circuit — stage 1 returns it and stage 2 still runs.
  const stage1Returns = returnsOf(parseAction);
  assert.equal(
    stage1Returns.length,
    1,
    because(
      "stage 1 no longer has exactly one exit",
      "a second exit is how an unparseable action would start short-circuiting — and a " +
        "short-circuit to the canned reply would make `cannedResponses` see the stage-1 case too, " +
        "leaving this clause withholding scores it no longer needs to withhold",
    ),
  );
  assert.equal(
    stage1Returns[0]?.indent,
    parseAction.indent,
    because(
      "stage 1's exit is now nested inside a branch",
      "an unconditional return is what guarantees a blank, unparseable action is handed onward " +
        "rather than intercepted, which is the case `llmCallFailures` is the only evidence of",
    ),
  );
  assert.match(
    stage1Returns[0]?.expression ?? "",
    /^[A-Za-z_]\w*$/,
    because(
      "stage 1 no longer returns the parsed action as a bare value",
      "returning a literal or a call instead means the blank the failed call produced is being " +
        "substituted for, and the answer stage 2 generates is no longer the ungated one described",
    ),
  );
  assert.equal(
    countWord(parseAction.code, "raise"),
    0,
    because(
      "stage 1 now raises",
      "a raised stage-1 failure is an errored ask the attempted-ask denominator already reports, " +
        "not the silent one this clause exists for",
    ),
  );
  assert.equal(
    countAssignments(parseAction.code, "content"),
    1,
    because(
      "stage 1 no longer binds the model's reply exactly once",
      "a second binding is how a default action would be substituted for the empty reply (`content " +
        "= content or \"unanswerable()\"`), which would make the generated answer gated after all",
    ),
  );
  assert.deepEqual(
    readPythonStrings(parseAction.source).returned,
    [],
    because(
      "stage 1 now returns a string literal on some path",
      "a literal action is a default standing in for the blank one, so the stage-2 answer would no " +
        "longer be generated with an empty `Action Chosen` block",
    ),
  );

  const askReturns = returnsOf(askSync);
  assert.equal(
    askReturns.length,
    1,
    because(
      "_ask_sync no longer has exactly one exit",
      "an earlier exit is a short-circuit on the stage-1 result — whatever it returns is then " +
        "either counted by `cannedResponses` or missing from `answers`, so this clause stops being " +
        "the only evidence of the stage-1 case and becomes redundant instead",
    ),
  );
  assert.match(
    askReturns[0]?.expression ?? "",
    /^_generate_response[ \t]*\(/,
    because(
      "_ask_sync no longer answers with the stage-2 call unconditionally",
      "a conditional answer (`CANNED if not action else _generate_response(...)`) is exactly the " +
        "short-circuit the rule assumes upstream does NOT do",
    ),
  );
  assert.equal(
    askReturns[0]?.indent,
    askSync.indent,
    because(
      "_ask_sync's exit is now nested inside a branch",
      "stage 2 running on every path, blank action included, is the premise that makes the damaged " +
        "answer one of the ones being counted real",
    ),
  );
  for (const keyword of ["if", "raise", "assert", "try", "for", "while"]) {
    assert.equal(
      countWord(askSync.code, keyword),
      0,
      because(
        `_ask_sync now contains a \`${keyword}\``,
        "the pipeline between the two stages is straight-line today, and any branch, guard or " +
          "handler inserted there is a decision about the blank action that this rule currently " +
          "assumes nobody makes",
      ),
    );
  }

  // Premise: the blank action is fed to a prompt that carries the gold, so it is not inert.
  const stage2Text = readPythonStrings(generateResponse.source).evaluated;
  const stage1Text = readPythonStrings(parseAction.source).evaluated;
  const fills = (runs: readonly string[], slot: string): boolean =>
    runs.some((run) => run.includes(slot));
  for (const slot of ["[[Action]]", "[[GT_SQL]]", "[[clear_query]]", "[[amb_json]]"]) {
    assert.ok(
      fills(stage2Text, slot),
      because(
        `stage 2's prompt no longer fills ${slot}`,
        "the harm of a blank action is that the answer is still generated WITH the ground-truth " +
          "SQL and the clear query in context and nothing saying whether the question was " +
          "answerable; drop those from the prompt and that harm has to be re-argued",
      ),
    );
  }
  assert.ok(
    countWord(generateResponse.code, "action") > 0,
    because(
      "stage 2 no longer uses the action it is passed",
      "an action slot that is filled from something other than stage 1's output means stage 1's " +
        "failure no longer reaches the generated answer at all",
    ),
  );
  for (const slot of ["[[Action]]", "[[GT_SQL]]", "[[clear_query]]"]) {
    assert.equal(
      fills(stage1Text, slot),
      false,
      because(
        `stage 1's prompt now fills ${slot} too`,
        "the asymmetry between the stages is the argument: stage 1 CHOOSES the action and stage 2 " +
          "is the one holding the gold, and a stage 1 that sees the same context is a different " +
          "failure mode than the one described",
      ),
    );
  }
  assert.ok(
    readPythonStrings(generateResponse.source).returned.includes(CANNED_USER_RESPONSE),
    because(
      "the canned reply is no longer stage 2's own fallback",
      "`cannedResponses` seeing the stage-2 case is half the asymmetry; if stage 2 falls back to " +
        "something else, or the canned reply moves to another stage, which failures are already " +
        "visible has changed",
    ),
  );
  assert.ok(
    countWord(parseAction.code, "USER_SIMULATOR_ACTION_PARSER") > 0 &&
      countWord(generateResponse.code, "USER_SIMULATOR_RESPONSE_GENERATOR") > 0,
    because(
      "the stages no longer use the action-parser and response-generator templates",
      "which template each stage runs is what makes stage 1 the gate and stage 2 the answer, and " +
        "the action space pinned from user_simulator/prompts.py is stage 1's only because of this",
    ),
  );
}

/** The text between the parentheses of the first call matching `call`, or `undefined`. */
function readCallArguments(code: string, call: RegExp): string | undefined {
  const match = call.exec(code);
  if (match === null) return undefined;
  let i = match.index + match[0].length - 1;
  let depth = 0;
  const start = i + 1;
  while (i < code.length) {
    const char = code.charAt(i);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
    }
    i += 1;
  }
  return undefined;
}

/** The expression `name` is first assigned, read across line breaks while brackets are open. */
function readAssignedExpression(code: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}[ \\t]*=(?!=)`).exec(code);
  if (match === null) return undefined;
  let i = match.index + match[0].length;
  const start = i;
  let depth = 0;
  while (i < code.length) {
    const char = code.charAt(i);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "\n" && depth <= 0) return code.slice(start, i);
    i += 1;
  }
  return code.slice(start);
}

/** Module-level `NAME = <int>` bindings, so a retry count named as a constant can be resolved. */
function moduleIntConstants(code: string): ReadonlyMap<string, number> {
  const constants = new Map<string, number>();
  for (const match of code.matchAll(/^([A-Za-z_]\w*)[ \t]*=[ \t]*(\d+)[ \t\r]*$/gm)) {
    constants.set(match[1] ?? "", Number(match[2]));
  }
  return constants;
}

/**
 * The retry budget the completion call is given, whether passed inline or splatted from a dict.
 *
 * Both forms are accepted because both hand the same number to the same call; upstream currently
 * builds a `kwargs` dict and splats it, and moving the argument into the call would change nothing
 * the argument depends on. A dict LITERAL (`{"num_retries": 5}`) is deliberately not resolved: the
 * key is a string, and this reader will not guess at a shape it cannot see through the mask. That
 * direction is a false alarm rather than a false pass, which is the way round this file chooses
 * everywhere else.
 */
function readRetryBudget(
  body: string,
  args: string,
  constants: ReadonlyMap<string, number>,
): number | undefined {
  const resolve = (token: string): number | undefined =>
    /^\d+$/.test(token) ? Number(token) : constants.get(token);
  const binding = /\bnum_retries[ \t]*=[ \t]*([A-Za-z_]\w*|\d+)/;
  const direct = binding.exec(args);
  if (direct !== null) return resolve(direct[1] ?? "");
  const splat = /\*\*([A-Za-z_]\w*)/.exec(args);
  if (splat === null) return undefined;
  const expression = readAssignedExpression(body, splat[1] ?? "");
  if (expression === undefined) return undefined;
  const indirect = binding.exec(expression);
  return indirect === null ? undefined : resolve(indirect[1] ?? "");
}

/**
 * The retry budget that makes ONE logged failure mean EVERY attempt failed.
 *
 * This is the premise the cost objection actually turns on. "Nine good answers and one transient
 * 429" assumes a 429 can write the line — and it cannot, because `shared/llm.py` hands
 * `num_retries` to `litellm.completion` and a rate limit is absorbed inside that call, several
 * attempts before `_call_llm`'s `except` is reached. So the line is written only by a call that
 * failed every attempt it was given: a request the model rejects outright (the hardcoded
 * `temperature=0` is the case that motivated this whole file), or a provider down across the budget.
 * Neither is transient, and both recur on the next ask.
 *
 * Delete the retry argument upstream and that stops being true in the direction that costs money:
 * a single blip would write the line, `void` would withhold a run that was fine, and nothing in
 * this package would say so. The count is held to being greater than one rather than to being 5,
 * because "more than one attempt" is the whole of what the argument needs and a bump from 5 to 8 is
 * not a contract change. Shared with `RETRY_MATRIX`, for the same reason the pipeline pin is.
 */
function assertOfficialRetryBudget(llm: string): void {
  const module = splitPythonSource(llm);
  const callLlm = readPythonFunction(module, "call_llm");
  assert.ok(
    callLlm,
    because(
      "shared/llm.py no longer defines call_llm()",
      "the simulator's every LLM call goes through that function, so the retry budget it is given " +
        "is what decides whether one logged `LLM call failed` line is a blip or a total failure",
    ),
  );
  const args = readCallArguments(callLlm.code, /\b(?:litellm[ \t]*\.[ \t]*)?completion[ \t]*\(/);
  assert.ok(
    args !== undefined,
    because(
      "call_llm no longer calls litellm's completion",
      "the retry semantics quoted in report-simulator.ts are litellm's, and a different client " +
        "brings its own — possibly none",
    ),
  );
  const budget = readRetryBudget(callLlm.code, args, moduleIntConstants(module.code));
  assert.ok(
    budget !== undefined,
    because(
      "call_llm no longer hands a retry count to the completion call",
      "without it a single transient 429 writes `LLM call failed`, and the rule starts withholding " +
        "every score from runs that were never broken — the exact over-strictness this pin " +
        "exists to prevent, only then it would be real",
    ),
  );
  assert.ok(
    budget > 1,
    because(
      `the completion call is now given ${budget} attempt(s)`,
      "one attempt means one failure is one failure, transient or not, and `void` on a single " +
        "logged line stops being a statement about a call that failed every attempt it had",
    ),
  );
}

/**
 * Stage 1's action space, held against the module the templates live in.
 *
 * The comment in `report-simulator.ts` says stage 1 IS the gate — "its space is `labeled()`,
 * `unlabeled()` and `unanswerable()`" — and that is what makes a blanked action slot a decision
 * silently skipped rather than a cosmetic gap. Rename or drop one of those and the sentence is
 * false, whatever else still holds.
 *
 * Containment is the right question HERE, unlike everywhere else in this file: `prompts.py` is
 * prompt text end to end, so what the file SAYS is what the model is told, and there is no
 * value-versus-literal gap for an indirection to hide in. The two template tables are checked as
 * assignments in masked code rather than as text, because those are names `server.py` imports.
 */
function assertOfficialActionSpace(prompts: string): void {
  const module = splitPythonSource(prompts);
  for (const table of ["USER_SIMULATOR_ACTION_PARSER", "USER_SIMULATOR_RESPONSE_GENERATOR"]) {
    assert.match(
      module.code,
      new RegExp(`^${table}[ \\t]*=`, "m"),
      because(
        `user_simulator/prompts.py no longer defines ${table}`,
        "server.py imports both tables by name and picks one per stage; a table that is gone means " +
          "the two-stage split itself has been reorganised",
      ),
    );
  }
  const prose = module.text.join("\n");
  const unlabeled = (prose.match(/\bunlabeled\(/g) ?? []).length;
  const labeled = (prose.match(/\blabeled\(/g) ?? []).length;
  assert.ok(
    labeled > 0 && unlabeled > 0 && prose.includes("unanswerable("),
    because(
      "stage 1's action space is no longer labeled() / unlabeled() / unanswerable()",
      "report-simulator.ts names those three as the decision a blank action skips, and " +
        "`unanswerable()` in particular is the one whose refusal sentence stage 2 is told to use " +
        "verbatim — a renamed or resized action space makes that account of the harm wrong",
    ),
  );
}

/**
 * The pipeline premises, read from the checkout the argument was written against.
 *
 * Gated like every other read of the official tree, and that gating is this file's known limit: CI
 * has no checkout, so the real pin runs on a developer's machine and `just test-bird-eval` is what
 * points it at `data/cache/BIRD-Interact`. The matrices below are what CI does get — they hold the
 * reader itself to telling a structural change from a reformat, so the day someone runs this
 * against a moved upstream, the failure is about upstream and not about the reader.
 */
test(
  "one /ask still spends two LLM calls, and a stage-1 failure still does not short-circuit",
  {
    skip:
      checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to pin the two-stage /ask pipeline" : false,
  },
  async () => {
    assert.ok(checkout);
    assertOfficialAskPipeline(
      await readFile(join(checkout, SOURCE_ROOT, SIMULATOR_SOURCE), "utf8"),
    );
  },
);

test(
  "the simulator's LLM calls are still given a retry budget larger than one attempt",
  {
    skip: checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to pin the retry budget" : false,
  },
  async () => {
    assert.ok(checkout);
    assertOfficialRetryBudget(await readFile(join(checkout, SOURCE_ROOT, RETRY_SOURCE), "utf8"));
  },
);

test(
  "stage 1 is still the gate, and its action space is still the three the report names",
  {
    skip: checkout === undefined ? "set BIRD_INTERACT_CHECKOUT to pin stage 1's action space" : false,
  },
  async () => {
    assert.ok(checkout);
    assertOfficialActionSpace(await readFile(join(checkout, SOURCE_ROOT, PROMPTS_SOURCE), "utf8"));
  },
);

/**
 * The official pipeline, reduced to the shape the pin reasons about.
 *
 * A faithful reduction of `BIRD-Interact-ADK/user_simulator/server.py`: same call graph, same
 * straight-line `_ask_sync`, same swallow-into-`""`, same prompt slots per stage, same canned
 * fallback in stage 2 and nowhere else. The gated test above is what proves the real file still has
 * this shape; the rows below mutate it one premise at a time, so a reader that answered "there are
 * two functions and a return somewhere" would pass on every one of them.
 */
const OFFICIAL_PIPELINE = [
  "def _call_llm(prompt: str, max_tokens: int = 200) -> str:",
  "    try:",
  "        from shared.llm import call_llm",
  "        return call_llm(",
  '            [{"role": "user", "content": prompt}],',
  "            model_name=settings.user_sim_model,",
  "            temperature=0,",
  "            max_tokens=max_tokens,",
  "        )",
  "    except Exception as e:",
  '        logger.error(f"LLM call failed: {e}")',
  '        return ""',
  "",
  "",
  "def _parse_action(state: TaskSimState, question: str) -> str:",
  '    """Stage 1: Action Parser — maps clarification question to action (AMB/LOC/UNA)."""',
  "    template = USER_SIMULATOR_ACTION_PARSER[PROMPT_VERSION]",
  '    prompt = template.replace("[[clarification_Q]]", question)',
  '    prompt = prompt.replace("[[amb_json]]", state.get_ambiguity_json())',
  '    prompt = prompt.replace("[[SQL_Glot]]", state.get_all_sql_segments())',
  '    prompt = prompt.replace("[[DB_schema]]", state.db_schema)',
  "    content = _call_llm(prompt, max_tokens=200)",
  '    if "</s>" in content:',
  '        action = content.split("</s>")[0].strip()',
  "    else:",
  '        action = content.split("\\n")[0].strip()',
  '    logger.info(f"Parsed action: {action}")',
  "    return action",
  "",
  "",
  "def _generate_response(state: TaskSimState, question: str, action: str) -> str:",
  '    """Stage 2: Response Generator — produces user response from action + context."""',
  "    template = USER_SIMULATOR_RESPONSE_GENERATOR[PROMPT_VERSION]",
  '    prompt = template.replace("[[clarification_Q]]", question)',
  '    prompt = prompt.replace("[[Action]]", action)',
  '    prompt = prompt.replace("[[clear_query]]", state.clear_query)',
  '    prompt = prompt.replace("[[amb_json]]", state.get_ambiguity_json())',
  '    prompt = prompt.replace("[[GT_SQL]]", state.get_gt_sql_str())',
  "    content = _call_llm(prompt, max_tokens=1024)",
  '    if "</s>" in content:',
  '        return content.split("</s>")[0].strip()',
  CANNED_RETURN,
  "",
  "",
  "def _ask_sync(state: TaskSimState, question: str) -> str:",
  '    """Two-stage pipeline: parse action, then generate response. Runs in thread pool."""',
  "    action = _parse_action(state, question)",
  "    return _generate_response(state, question, action)",
  "",
  "",
  '@app.post("/ask", response_model=AskUserResponse)',
  "async def ask_user(req: AskUserRequest):",
  "    state = _task_states.get(req.task_id)",
  "    if not state:",
  '        raise HTTPException(404, f"Task {req.task_id} not initialized")',
  "    response = await asyncio.to_thread(_ask_sync, state, req.question)",
  "    return AskUserResponse(answer=response)",
  "",
].join("\n");

const rewritePipeline = (from: string, to: string): string => {
  assert.ok(OFFICIAL_PIPELINE.includes(from), `the reduction no longer contains: ${from}`);
  return OFFICIAL_PIPELINE.replace(from, to);
};

/**
 * Upstreams the pipeline pin has to tell apart, and the answer it owes for each.
 *
 * `accepted` is not a taste call either: it is whether the ARGUMENT in `assessSimulator`'s comment
 * still holds. Every rejected row breaks one of its premises — the two-call count, the silent
 * swallow, the un-short-circuited blank action, or the gold sitting in stage 2's prompt — and every
 * accepted row changes only how the same pipeline is spelled. A rejected row does not always mean
 * the rule became UNSOUND: a short-circuit to the canned reply would make it merely redundant. It
 * means a human has to work out which, because the comment will go on asserting the old answer.
 */
const PIPELINE_MATRIX: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly accepted: boolean;
  readonly why: string;
}> = [
  {
    name: "faithful",
    source: OFFICIAL_PIPELINE,
    accepted: true,
    why: "the official pipeline, unchanged",
  },
  {
    name: "stage 1 short-circuited to the canned reply",
    source: rewritePipeline(
      "    action = _parse_action(state, question)\n    return _generate_response(state, question, action)",
      [
        "    action = _parse_action(state, question)",
        "    if not action:",
        `        return "I'm not sure I understand your question."`,
        "    return _generate_response(state, question, action)",
      ].join("\n"),
    ),
    accepted: false,
    why: "the stage-1 case would become visible to cannedResponses, and this clause redundant",
  },
  {
    name: "stage 1 raising instead of returning a blank action",
    source: rewritePipeline(
      "    content = _call_llm(prompt, max_tokens=200)",
      [
        "    content = _call_llm(prompt, max_tokens=200)",
        "    if not content:",
        '        raise RuntimeError("action parser returned nothing")',
      ].join("\n"),
    ),
    accepted: false,
    why: "a raised failure is an errored ask the attempted-ask denominator already reports",
  },
  {
    name: "stage 1 defaulting the blank action",
    source: rewritePipeline(
      "    content = _call_llm(prompt, max_tokens=200)",
      [
        "    content = _call_llm(prompt, max_tokens=200)",
        '    content = content or "<s>unanswerable()</s>"',
      ].join("\n"),
    ),
    accepted: false,
    why: "a defaulted action means stage 2 is gated after all, so the answer is no longer ungated",
  },
  {
    name: "the two stages collapsed into one call",
    source: OFFICIAL_PIPELINE.slice(0, OFFICIAL_PIPELINE.indexOf("def _parse_action")) +
      OFFICIAL_PIPELINE.slice(OFFICIAL_PIPELINE.indexOf("def _generate_response")).replace(
        "    action = _parse_action(state, question)\n    return _generate_response(state, question, action)",
        '    return _generate_response(state, question, "")',
      ),
    accepted: false,
    why: "one ask would spend one LLM call, and the arithmetic the rule refuses would become right",
  },
  {
    name: "_call_llm re-raising instead of swallowing",
    source: rewritePipeline(
      '        logger.error(f"LLM call failed: {e}")\n        return ""',
      '        logger.error(f"LLM call failed: {e}")\n        raise',
    ),
    accepted: false,
    why: "a propagated failure surfaces as an errored ask rather than as a silent blank action",
  },
  {
    name: "_call_llm retrying on its own",
    source: rewritePipeline(
      "def _call_llm(prompt: str, max_tokens: int = 200) -> str:\n    try:",
      "def _call_llm(prompt: str, max_tokens: int = 200) -> str:\n    for attempt in range(3):\n      try:",
    ),
    accepted: false,
    why: "a second retry layer changes what a single logged line is evidence of",
  },
  {
    name: "the ground-truth SQL dropped from stage 2's prompt",
    source: rewritePipeline(
      '    prompt = prompt.replace("[[GT_SQL]]", state.get_gt_sql_str())\n',
      "",
    ),
    accepted: false,
    why: "the harm of a blank action is that the answer is generated with gold in context",
  },
  {
    name: "the action slot dropped from stage 2's prompt",
    source: rewritePipeline('    prompt = prompt.replace("[[Action]]", action)\n', ""),
    accepted: false,
    why: "stage 1's result would no longer reach the generated answer at all",
  },
  {
    name: "the ground-truth SQL added to stage 1's prompt",
    source: rewritePipeline(
      '    prompt = prompt.replace("[[SQL_Glot]]", state.get_all_sql_segments())',
      [
        '    prompt = prompt.replace("[[SQL_Glot]]", state.get_all_sql_segments())',
        '    prompt = prompt.replace("[[GT_SQL]]", state.get_gt_sql_str())',
      ].join("\n"),
    ),
    accepted: false,
    why: "the asymmetry between a gate stage and a gold-holding answer stage is the argument",
  },
  {
    name: "the /ask endpoint bypassing the pipeline",
    source: rewritePipeline(
      "    response = await asyncio.to_thread(_ask_sync, state, req.question)",
      "    response = await asyncio.to_thread(_generate_response, state, req.question, \"\")",
    ),
    accepted: false,
    why: "a charged ask would no longer spend the calls the rule counts",
  },
  {
    name: "stage 2's canned fallback reworded",
    source: rewritePipeline(CANNED_RETURN, `    return "Sorry, I could not follow that question."`),
    accepted: false,
    why: "cannedResponses seeing the stage-2 case is half the asymmetry",
  },
  {
    name: "reformatted across lines, with comments and a renamed local",
    source: rewritePipeline(
      "    action = _parse_action(state, question)\n    return _generate_response(state, question, action)",
      [
        "    chosen = _parse_action(state, question)  # stage 1: the gate",
        "    return _generate_response(",
        "        state,",
        "        question,",
        "        chosen,  # blank when stage 1 failed, and passed on anyway",
        "    )",
      ].join("\n"),
    ),
    accepted: true,
    why: "wrapping, commenting and renaming a local change nothing the argument depends on",
  },
  {
    name: "the short-circuit surviving only in a comment",
    source: rewritePipeline(
      "    action = _parse_action(state, question)",
      [
        "    action = _parse_action(state, question)",
        '    # was: if not action: return "I\'m not sure I understand your question."',
      ].join("\n"),
    ),
    accepted: true,
    why: "a guard quoted in a comment is not a guard the pipeline ever runs",
  },
];

for (const { name, source, accepted, why } of PIPELINE_MATRIX) {
  test(`pipeline pin ${accepted ? "accepts" : "rejects"}: ${name}`, () => {
    if (accepted) {
      assert.doesNotThrow(() => assertOfficialAskPipeline(source), why);
      return;
    }
    assert.throws(() => assertOfficialAskPipeline(source), assert.AssertionError, why);
  });
}

/** The official retry path, reduced to the shape the pin reasons about. */
const OFFICIAL_RETRY = [
  "MAX_RETRIES = 5",
  "",
  "try:",
  "    from shared._local_provider import call_llm, build_adk_model",
  "except ImportError:",
  "    def call_llm(messages: list, model_name: str = None, temperature: float = 0) -> str:",
  '        """Call LLM via LiteLlm. Retries on rate limit / transient errors."""',
  "        import litellm",
  "        model_name = model_name or settings.system_agent_model",
  "        kwargs = dict(",
  "            model=model_name,",
  "            messages=messages,",
  "            temperature=temperature,",
  "            num_retries=MAX_RETRIES,",
  "        )",
  "        if settings.litellm_api_base:",
  '            kwargs["api_base"] = settings.litellm_api_base',
  "",
  "        resp = litellm.completion(**kwargs)",
  "        return resp.choices[0].message.content.strip()",
  "",
  "    def build_adk_model(model_name: str = None):",
  "        return LiteLlm(model=model_name, num_retries=MAX_RETRIES)",
  "",
].join("\n");

const rewriteRetry = (from: string, to: string): string => {
  assert.ok(OFFICIAL_RETRY.includes(from), `the reduction no longer contains: ${from}`);
  return OFFICIAL_RETRY.replace(from, to);
};

/**
 * Upstreams the retry pin has to tell apart.
 *
 * The accepted rows are all ways of handing the same budget to the same call; the rejected ones all
 * end with a single transient failure able to write `LLM call failed`, which is the one reading
 * under which the objection to `void` would be correct.
 */
const RETRY_MATRIX: ReadonlyArray<{
  readonly name: string;
  readonly source: string;
  readonly accepted: boolean;
  readonly why: string;
}> = [
  { name: "faithful", source: OFFICIAL_RETRY, accepted: true, why: "the official file, unchanged" },
  {
    name: "the retry argument dropped",
    source: rewriteRetry("            num_retries=MAX_RETRIES,\n", ""),
    accepted: false,
    why: "one 429 would then write the counted line, and void would withhold a healthy run",
  },
  {
    name: "the budget cut to a single attempt",
    source: rewriteRetry("MAX_RETRIES = 5", "MAX_RETRIES = 1"),
    accepted: false,
    why: "one attempt means one failure is one failure, transient or not",
  },
  {
    name: "the budget raised",
    source: rewriteRetry("MAX_RETRIES = 5", "MAX_RETRIES = 8"),
    accepted: true,
    why: "more than one attempt is the whole of what the argument needs",
  },
  {
    name: "the budget passed inline instead of splatted",
    source: rewriteRetry(
      "        resp = litellm.completion(**kwargs)",
      "        resp = litellm.completion(model=model_name, messages=messages, num_retries=MAX_RETRIES)",
    ),
    accepted: true,
    why: "the same number reaches the same call",
  },
  {
    name: "the budget written as a literal",
    source: rewriteRetry("            num_retries=MAX_RETRIES,", "            num_retries=5,"),
    accepted: true,
    why: "a literal budget is still a budget",
  },
  {
    name: "completion imported by name",
    source: rewriteRetry(
      "        resp = litellm.completion(**kwargs)",
      "        resp = completion(**kwargs)",
    ),
    accepted: true,
    why: "importing the function changes nothing about what it is given",
  },
  {
    name: "the retry argument surviving only in a comment",
    source: rewriteRetry(
      "            num_retries=MAX_RETRIES,",
      "            # num_retries=MAX_RETRIES,  # dropped, litellm handles it now",
    ),
    accepted: false,
    why: "a commented-out argument is never passed to anything",
  },
  {
    name: "the budget left only on the ADK model builder",
    source: rewriteRetry("            num_retries=MAX_RETRIES,\n", "").replace(
      "def build_adk_model(model_name: str = None):",
      "def build_adk_model(model_name: str = None):  # still retried here",
    ),
    accepted: false,
    why: "the system agent's model is not the simulator's, and the simulator is what this measures",
  },
];

for (const { name, source, accepted, why } of RETRY_MATRIX) {
  test(`retry pin ${accepted ? "accepts" : "rejects"}: ${name}`, () => {
    if (accepted) {
      assert.doesNotThrow(() => assertOfficialRetryBudget(source), why);
      return;
    }
    assert.throws(() => assertOfficialRetryBudget(source), assert.AssertionError, why);
  });
}
