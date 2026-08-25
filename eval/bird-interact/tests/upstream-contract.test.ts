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
