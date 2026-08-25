import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_LIMIT } from "../src/preview-truncation.js";
import { CLASS_LABEL } from "../src/report-diagnose.js";
import { esc, formatSql, renderReportHtml } from "../src/report-html.js";
import { GATED_GROUND_TRUTH_NOTICE, type RunReportIR } from "../src/report-model.js";

/**
 * Every gold statement in this file is invented.
 *
 * This file is committed; the benchmark's real `sol_sql` is gated material that lives only in the
 * gitignored `data/` tree, and none of it may be copied here.
 */
const GOLD_FLAT =
  `WITH q AS (SELECT hull_class FROM invented_hulls WHERE scanned) SELECT hull_class, COUNT(*) AS n FROM q GROUP BY hull_class ORDER BY n DESC`;

/** Phase 2's gold, from the dataset's `follow_up`, which answers a different question. */
const FOLLOW_UP_GOLD = `-- the invented follow-up gold\nSELECT AVG(mass_kg) FROM invented_hulls`;

function report(over: Partial<RunReportIR> = {}): RunReportIR {
  return {
    version: 1,
    generatedAt: "2026-08-25 11:41",
    gatedNotice: GATED_GROUND_TRUTH_NOTICE,
    provenance: {
      run: "alien-5", officialCommit: "4".repeat(40), publicSnapshotCommit: "5".repeat(40),
      imageId: "sha256:abc", repoDigests: [], wrenVersion: "wrenai 0.8.1", pythonVersion: "3.11.15",
      taskIds: ["alien_1"], systemModel: "claude-sonnet-4-5-20250929", userSimulatorModel: "openai/gpt-4o",
    },
    simulator: { llmCallFailures: 0, asks: 1, answered: 1, cannedResponses: 0, verdict: "healthy" },
    warnings: ["Query subset; never comparable with the official leaderboard."],
    defects: [],
    strict: { totalTasks: 1, totalReward: 0, averageReward: 0, phase1Count: 0, phase1Rate: 0, phase2Count: 0, phase2Rate: 0 },
    tolerant: null,
    withheld: null,
    budget: { used: 18, initial: 18, exhaustedTasks: 1 },
    byDifficulty: [{ key: "Moderate", tasks: 1, averageReward: 0, phase1Count: 0 }],
    byHighLevel: [{ key: "false", tasks: 1, averageReward: 0, phase1Count: 0 }],
    difficultyVocabularies: ["Moderate"],
    tasks: [{
      taskId: "alien_1", database: "alien", category: "Query", difficultyTier: "Moderate", highLevel: false,
      reward: 0, phase1Passed: false, phase2Passed: false, tolerantPassed: null,
      budgetUsed: 18, budgetRemaining: -1, initialBudget: 18, modelTurns: 23, elapsedSeconds: 65.6,
      toolCalls: { submit_sql: 3 }, goldSql: [GOLD_FLAT], followUpGoldSql: [FOLLOW_UP_GOLD],
      submits: [], asks: [],
      knowledge: { required: [0], withheld: [0], recovered: [], missed: [0] },
      ambiguities: [], failureClass: "intent-miss",
    }],
    ...over,
  };
}

/** The rest of a withheld IR: nulled verdicts, so a fixture cannot publish what the schema forbids. */
function withheldRest(): Pick<RunReportIR, "byDifficulty" | "byHighLevel" | "tasks"> {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  return {
    byDifficulty: base.byDifficulty.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    byHighLevel: base.byHighLevel.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    tasks: [
      {
        ...task,
        reward: null, phase1Passed: null, phase2Passed: null, tolerantPassed: null, failureClass: null,
        submits: task.submits.map((s) => ({ ...s, phase: null, result: null })),
      },
    ],
  };
}

test("esc neutralises every HTML metacharacter", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("the page renders every section and is self-contained", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(!/<script\s+src=|<link\s+rel="stylesheet"/i.test(html), "must embed its own styles");
  for (const heading of ["Before comparing these", "Reward", "Budget", "Tasks"]) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(html.includes("alien_1"));
});

/**
 * A withheld run as the IR delivers it: every per-task verdict and breakdown score already `null`.
 *
 * The renderer is not what decides this, and the fixture says so — it carries the nulls the
 * builder produced and the schema enforces, so the page has nothing to publish even if it tried.
 */
function withheldReport(): RunReportIR {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  return {
    ...base,
    strict: null,
    tolerant: null,
    withheld: "the user simulator answered nothing",
    simulator: { llmCallFailures: 3, asks: 5, answered: 5, cannedResponses: 5, verdict: "void" },
    byDifficulty: base.byDifficulty.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    byHighLevel: base.byHighLevel.map((g) => ({ ...g, averageReward: null, phase1Count: null })),
    tasks: [
      {
        ...task,
        reward: null, phase1Passed: null, phase2Passed: null, tolerantPassed: null, failureClass: null,
        submits: task.submits.map((s) => ({ ...s, phase: null, result: null })),
      },
    ],
  };
}

test("a withheld run renders the reason and never the number", () => {
  const html = renderReportHtml([withheldReport()]);
  assert.ok(html.includes("the user simulator answered nothing"));
  assert.ok(!/average_?[Rr]eward|0\.00/.test(html), "a void run must not render a score");
});

/**
 * The defect this test exists for: the recorded VOID run's page printed "answered a different
 * question — a critical ambiguity was resolved wrongly" five times, in the same rows whose reward
 * cells said `withheld`. `passed (strict)` is reachable by the same route, which is the exact
 * quotable figure the rule exists to suppress.
 */
/**
 * The cells of one task row, so a claim about the failure-class COLUMN can be made about the
 * column rather than about the whole page: an empty cell publishes no label either, and would pass
 * a page-wide "no label anywhere" assertion while saying nothing where the verdict belongs.
 */
function taskCells(html: string, taskId: string): string[] {
  const row = new RegExp(`<th scope="row"><code>${taskId}</code></th>([\\s\\S]*?)</tr>`).exec(html);
  const cells = row?.[1];
  assert.ok(cells !== undefined, `no task row for ${taskId}`);
  return [...cells.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? "");
}

/** Category, difficulty, reward, phase 1, phase 2, tolerant, budget, class, ambiguities. */
const CLASS_CELL = 7;

test("a withheld run publishes no per-task failure class", () => {
  const html = renderReportHtml([withheldReport()]);
  for (const label of Object.values(CLASS_LABEL)) {
    assert.ok(!html.includes(label), `a withheld run rendered a per-task verdict: ${label}`);
  }
  assert.match(html, /Why it landed there/, "the column is still there");
  const cells = taskCells(html, "alien_1");
  assert.equal(cells.length, 9, `unexpected task row shape: ${cells.join(" | ")}`);
  assert.equal(
    cells[CLASS_CELL],
    `<span class="held">withheld</span>`,
    "the failure-class cell states the withholding rather than going blank",
  );
  for (const index of [2, 3, 4, 5]) {
    assert.equal(cells[index], `<span class="held">withheld</span>`, `cell ${index} is not withheld`);
  }
});

test("a withheld run publishes no breakdown average and no per-task reward", () => {
  const html = renderReportHtml([
    {
      ...withheldReport(),
      byDifficulty: [{ key: "Moderate", tasks: 1, averageReward: null, phase1Count: null }],
    },
  ]);
  // The row is still on the page — which tasks ran is not a score — but every score cell is held.
  assert.ok(html.includes("Moderate"));
  assert.ok(!/0\.\d\d/.test(html), "no two-place score of any kind reaches the page");
});

/* -------------------------------------------------------------------------- */
/* The submission block, which is where the withheld score walked out          */
/* -------------------------------------------------------------------------- */

/** The `alien_1` trace, three attempts deep, as a page would receive it. */
const SUBMITS: RunReportIR["tasks"][number]["submits"] = [
  { attempt: 1, phase: 1, cost: 3, budgetBefore: 18, budgetAfter: 15, semanticSql: "SELECT 1", nativeSql: "SELECT 1 /* planned */", result: "SQL failed Phase 1. Your SQL is not correct.\nBudget remaining: 15.0 bird-coins" },
  { attempt: 2, phase: 1, cost: 3, budgetBefore: 15, budgetAfter: 12, semanticSql: "SELECT 2", nativeSql: null, result: "Phase 1 correct! (Reward: 0.7). Moving to Phase 2.\nReward: 0.7" },
  { attempt: 3, phase: 2, cost: 3, budgetBefore: 12, budgetAfter: 9, semanticSql: "SELECT 3", nativeSql: null, result: "Phase 2 correct! (Reward: 0.3). Task finished." },
];

function withSubmits(base: RunReportIR, submits: RunReportIR["tasks"][number]["submits"]): RunReportIR {
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  return { ...base, tasks: [{ ...task, submits }] };
}

/**
 * The finding: sixteen `SQL failed Phase 1.` lines under a page of withheld cells.
 *
 * Counting them recovered "0 of 5 tasks passed phase 1" verbatim, and on a run with a passing task
 * the same block would have printed `Reward: 0.7`. The IR nulls both fields now, and the page has
 * to render that as a withholding rather than as a blank or a "phase unrecorded".
 */
test("a withheld run renders every attempt and nothing the scorer said", () => {
  const held = withheldReport();
  const withheldSubmits = SUBMITS.map((s) => ({ ...s, phase: null, result: null }));
  const html = renderReportHtml([withSubmits(held, withheldSubmits)]);

  // What the agent did is all still there: three attempts, the SQL, the cost, the budget.
  for (const fragment of ["Attempt 1", "Attempt 2", "Attempt 3", "SELECT 1", "SELECT 2", "SELECT 3", "cost 3"]) {
    assert.ok(html.includes(fragment), `a withheld page dropped a fact about the run: ${fragment}`);
  }
  // What the scorer said is not, in any of its wordings.
  for (const said of ["failed Phase 1", "Phase 1 correct", "Phase 2 correct", "Reward: 0.7", "Reward: 0.3"]) {
    assert.ok(!html.includes(said), `a withheld page rendered the scorer's verdict: ${said}`);
  }
  assert.ok(html.includes("outcome withheld"), "the page says the outcome is withheld, not nothing");
  // A `phase 2` label is the same leak in a number: only a task the scorer passed is asked the
  // follow-up. And it must not read as "the trace forgot to record it".
  assert.ok(!/phase \d/i.test(html.slice(html.indexOf("<h5>Submissions</h5>"))), "no phase label survives");
  assert.ok(!html.includes("phase unrecorded"), "a withheld phase is not an unrecorded one");
  assert.ok(html.includes("phase withheld"));
});

test("a reportable run still renders what the scorer said and which phase answered it", () => {
  const html = renderReportHtml([withSubmits(report(), SUBMITS)]);
  assert.ok(html.includes("SQL failed Phase 1. Your SQL is not correct."));
  assert.ok(html.includes("Phase 1 correct! (Reward: 0.7). Moving to Phase 2."));
  assert.ok(html.includes("phase 2"), "a reportable run labels the follow-up submission");
  assert.ok(!html.includes("outcome withheld"));
});

/**
 * A trace that recorded no phase on a reportable run is a different statement, and stays one.
 *
 * `null` means two things now — the trace kept none, or the report withheld it — and a page that
 * spelled both "phase unrecorded" would blame the trace for a decision the report made.
 */
test("an unrecorded phase and a withheld phase read differently", () => {
  const unphased = renderReportHtml([withSubmits(report(), [{ ...SUBMITS[0]!, phase: null }])]);
  assert.ok(unphased.includes("phase unrecorded"));
  assert.ok(!unphased.includes("phase withheld"));
});

test("a reportable run still renders its per-task failure class", () => {
  const cells = taskCells(renderReportHtml([report()]), "alien_1");
  assert.equal(cells[CLASS_CELL], esc(CLASS_LABEL["intent-miss"]), "a trustworthy run publishes it");
});

test("an uncomputed tolerant column says so instead of rendering blank", () => {
  assert.match(renderReportHtml([report()]), /not computed/i);
});

test("a computed tolerant score renders beside strict", () => {
  const html = renderReportHtml([
    report({ tolerant: { totalTasks: 1, phase1Count: 1, phase1Rate: 1, phase2Count: 0, phase2Rate: 0 } }),
  ]);
  assert.ok(html.includes("tolerant") || html.includes("Tolerant"));
  assert.ok(!/not computed/i.test(html));
});

/**
 * "Average reward (tolerant) 0.60" sat one line under "Average reward (strict) 0.20", and the
 * tolerant figure was the pass RATE. Two units, read off the page as one number tripling.
 */
test("the tolerant column is labelled as tasks passed, never as a reward", () => {
  const html = renderReportHtml([
    report({ tolerant: { totalTasks: 5, phase1Count: 3, phase1Rate: 0.6, phase2Count: 0, phase2Rate: 0 } }),
  ]);
  assert.ok(!/reward \(tolerant\)/i.test(html), "no reward-named row may carry a tolerant number");
  assert.match(html, /Tasks passed phase 1 \(tolerant\)/, "it is labelled as the task count it is");
  assert.match(html, /Average reward \(strict\)/, "strict keeps its genuine reward average");
  assert.match(html, /counts tasks passed and carries no reward/i, "and the page says why");
});

/**
 * Asks attempted and asks answered are different numbers and the page has to show both: the run
 * that motivated this attempted asks and answered none, and a single "Asks" column could not tell
 * that apart from a run that was never asked anything.
 */
test("the simulator table reports asks attempted beside asks answered", () => {
  const html = renderReportHtml([
    report({ simulator: { llmCallFailures: 0, asks: 3, answered: 0, cannedResponses: 0, verdict: "void" }, strict: null, tolerant: null, withheld: "no ask was answered", ...withheldRest() }),
  ]);
  assert.match(html, /Asks attempted/, "the column says what it counts");
  assert.match(html, /<th scope="col">Answered<\/th>/, "and answered is its own column");
  assert.match(html, /<td>3<\/td><td>0<\/td>/, "three attempted, none answered");
});

/**
 * `inconclusive` must not read as `miss`: it says the fragment references no qualified column, so
 * it could not be graded at all. Folding it into `miss` is what manufactured `intent-miss`.
 */
test("an ungradable ambiguity renders as its own grade, not as a miss", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([
    {
      ...base,
      tasks: [
        {
          ...task,
          ambiguities: [
            { term: "analyzable", type: "schema_linking_ambiguity", isMask: true, critical: true, match: "inconclusive" },
            { term: "hull load", type: "knowledge_linking_ambiguity", isMask: true, critical: true, match: "miss" },
          ],
        },
      ],
    },
  ]);
  assert.match(html, /class="amb inconclusive"/, "the grade carries its own class");
  assert.match(html, /class="amb miss"/, "and is not rendered as the miss beside it");
  assert.match(html, /\.amb\.inconclusive\{/, "the stylesheet tells the two apart");
  assert.match(html, /cannot be graded by columns/i, "the legend says what the grade means");
  assert.match(html, /Only a critical <strong>miss<\/strong> is evidence of a misread/i);
});

/**
 * The dash the empty case prints reads as "the report looked and found none", and for the recovery
 * pair that is a per-id claim nothing in the inputs supports — the report reads no knowledge base,
 * so an open ask channel ties no answer to an id. The page has to say which of the two it means.
 */
test("undetermined knowledge recovery says so rather than rendering a dash", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const undetermined = renderReportHtml([
    {
      ...base,
      tasks: [
        { ...task, knowledge: { required: [0, 50], withheld: [0], recovered: null, missed: null } },
      ],
    },
  ]);
  assert.match(undetermined, /not determined/, "an undetermined pair states itself");
  assert.match(undetermined, /reads no knowledge base/i, "and says why it could not be determined");
  // A determined pair still renders the ids it determined, and an empty determined list its dash.
  const determined = renderReportHtml([
    {
      ...base,
      tasks: [
        { ...task, knowledge: { required: [0], withheld: [0], recovered: [], missed: [0] } },
      ],
    },
  ]);
  assert.ok(!/not determined/.test(determined), "a determined pair claims nothing about evidence");
});

/**
 * The one row withholding did not reach.
 *
 * A `void` run is a run whose simulator answered nothing, so `missed` names every withheld entry —
 * and the page printed *Never obtained: 0* beside a masked reward, a masked phase verdict and a
 * masked failure class. "Never obtained" has an actor in it: on a run whose own simulator row says
 * its answers were meaningless, the reason the entry never arrived is that the channel was closed,
 * not that the agent failed to ask. The field itself stays — it is a fact about the record, which
 * a withheld run reports in full, and masking a field the IR publishes would be the renderer
 * deciding a suppression the document did not. What changes is the sentence.
 */
test("a withheld run states the knowledge it never received without accusing the agent", () => {
  const held = withheldReport();
  const task = held.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([
    { ...held, tasks: [{ ...task, knowledge: { required: [0], withheld: [0], recovered: [], missed: [0] } }] },
  ]);
  assert.ok(
    !/Never obtained/.test(html),
    "a withheld run said the agent never obtained an entry its own simulator never delivered",
  );
  assert.match(
    html,
    /Not delivered by the ask channel<\/dt><dd>0/,
    "the ids are still reported, as facts about the record",
  );
  assert.match(html, /publishes no verdict/i, "and the row says it is not one");
});

/** The converse: a run that publishes its verdicts publishes this one in its own words too. */
test("a reportable run still names the entries never obtained", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /Never obtained<\/dt><dd>0/);
  assert.ok(!/publishes no verdict/i.test(html), "there is nothing to disclaim on a scored run");
});

/**
 * `intent-ungraded` has two reasons now and only one sentence.
 *
 * `CLASS_LABEL` says "no critical ambiguity in the record was resolvable either way", which is the
 * reason the class was introduced for. A task whose knowledge recovery is undetermined lands there
 * too — `intent-ok` is a claim missed knowledge is allowed to overturn, and an undetermined channel
 * cannot say whether it does — and on that task a critical ambiguity WAS resolvable. Printing the
 * original sentence there states something the page's own ambiguity column contradicts.
 */
test("an ungraded class names the reason it could not be graded", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const undetermined = taskCells(
    renderReportHtml([
      {
        ...base,
        tasks: [
          {
            ...task,
            failureClass: "intent-ungraded",
            knowledge: { required: [0, 50], withheld: [0], recovered: null, missed: null },
          },
        ],
      },
    ]),
    "alien_1",
  );
  assert.match(undetermined[CLASS_CELL] ?? "", /could not be graded/, "it is still the same class");
  assert.match(undetermined[CLASS_CELL] ?? "", /knowledge/i, "and it names the undetermined half");
  assert.notEqual(
    undetermined[CLASS_CELL],
    esc(CLASS_LABEL["intent-ungraded"]),
    "the ambiguity sentence is false here: one was graded and found present",
  );
  // The reason the class was introduced for keeps the sentence it was written for.
  const ungradable = taskCells(
    renderReportHtml([
      { ...base, tasks: [{ ...task, failureClass: "intent-ungraded" }] },
    ]),
    "alien_1",
  );
  assert.equal(ungradable[CLASS_CELL], esc(CLASS_LABEL["intent-ungraded"]));
});

/**
 * `inconclusive` covers two different silences now, and the legend that explains the grade has to
 * cover both: a fragment with no qualified column to grade, and a submission the recorder cut
 * short, whose missing fragment may sit past the cut. Only the legend stands between a reader and
 * reading a dashed cell as a miss.
 */
test("the ambiguity legend says a record cut short cannot be graded a miss", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /cut short/i, "the legend names the recording limit");
  assert.match(html, /2,000/, "and the length at which it cuts");
});

test("defects are rendered rather than dropped", () => {
  const html = renderReportHtml([report({ defects: ["alien_1: official reward 0 but trace reward 1"] })]);
  assert.ok(html.includes("official reward 0 but trace reward 1"));
});

test("the same report renders byte-identically twice", () => {
  assert.equal(renderReportHtml([report()]), renderReportHtml([report()]));
});

// ---------------------------------------------------------------------------
// The Wren-planned SQL formatter
// ---------------------------------------------------------------------------

/**
 * Remove every space that is not inside a quoted run.
 *
 * Written from scratch here rather than reusing the renderer's lexer: a formatter checked
 * against its own tokeniser would agree with itself about a bug.
 */
function squash(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (c === "'" || c === '"') {
      out += c;
      i += 1;
      while (i < sql.length) {
        const d = sql.charAt(i);
        out += d;
        i += 1;
        if (d === c) {
          if (sql.charAt(i) === c) {
            out += c;
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (!/\s/.test(c)) out += c;
    i += 1;
  }
  return out;
}

const PLANNED: readonly string[] = [
  `WITH signals AS (SELECT "wren_src_signals".snrratio FROM (SELECT signals.snrratio FROM "public".signals AS __source) AS signals) SELECT * FROM signals WHERE x = 'SELECT FROM' ORDER BY snrratio`,
  `SELECT 'two  spaces   and\ta tab' AS kept FROM "t" WHERE "GROUP BY" = 'where (not) a clause'`,
  `SELECT a FROM t LEFT OUTER JOIN u ON t.id = u.id INNER JOIN v ON v.id = t.id GROUP BY a HAVING COUNT(*) > 1 UNION ALL SELECT b FROM w LIMIT 10`,
  `SELECT ROUND(CAST(ARRAY_AGG(grade ORDER BY grade) AS TEXT), 2), COUNT(*) FILTER(WHERE grade > 0) FROM invented_scans`,
  `SELECT x FROM t WHERE name = 'it''s here' AND "quoted ""ident""" = 1`,
  // The stored plan is truncated at a fixed length, so it can end mid-literal.
  `WITH a AS (SELECT 1 FROM (SELECT 2 FROM x) y) SELECT * FROM a WHERE z = 'unterminated`,
  "",
  "   ",
];

test("formatting the planned SQL only ever moves whitespace between tokens", () => {
  for (const sql of PLANNED) {
    assert.equal(squash(formatSql(sql)), squash(sql), `token sequence changed for: ${sql}`);
    assert.equal(
      formatSql(sql).replace(/\s/g, ""),
      sql.replace(/\s/g, ""),
      `a non-whitespace character was added or removed for: ${sql}`,
    );
  }
});

test("a literal's own contents survive formatting byte for byte", () => {
  const sql = `SELECT 'two  spaces   and\ta tab' AS kept, "wren_src_signals".x FROM "public".t WHERE y = 'SELECT FROM'`;
  const out = formatSql(sql);
  assert.ok(out.includes(`'two  spaces   and\ta tab'`), "whitespace inside a literal is untouched");
  assert.ok(out.includes(`'SELECT FROM'`), "a keyword inside a literal is untouched");
  assert.ok(out.includes(`"wren_src_signals"`), "a quoted identifier is untouched");
  // The keyword inside the literal did not become a clause break.
  assert.equal(out.split("\n").filter((l) => l.includes(`'SELECT FROM'`)).length, 1);
});

test("the flat planned statement gains line breaks and depth indentation", () => {
  const flat = `WITH scans AS (SELECT "wren_src_scans".grade FROM (SELECT scans.grade FROM "public".scans AS __source) AS scans) SELECT class_name FROM invented_loads GROUP BY class_name ORDER BY avg_load`;
  assert.equal(flat.split("\n").length, 1);
  const lines = formatSql(flat).split("\n");
  assert.ok(lines.length >= 6, `expected several lines, got ${lines.length}`);
  assert.ok(
    lines.some((l) => l.startsWith("    SELECT")),
    "a doubly nested subquery is indented twice",
  );
  assert.ok(lines.includes("GROUP BY class_name"));
  assert.ok(lines.includes("ORDER BY avg_load"));
});

/**
 * An invented statement laid out the way the benchmark lays gold out.
 *
 * Every construct here is one the formatter used to re-break in REAL gold, and each is the reason
 * a line of it is here — the old fixture had none of them and so guarded nothing:
 *
 * - an inline `JOIN … ON …`, split so the `ON` landed at parenthesis depth 0 while the `JOIN` it
 *   belongs to sat at the author's four-space indent;
 * - `WITHIN GROUP (ORDER BY …)`, whose `ORDER BY` is inside a function call the clause list has no
 *   notion of, split onto a line indented by depth instead;
 * - `FILTER (WHERE …)`, the same defect through a different keyword;
 * - a leading block comment and an indented `-- Step` comment, which surround the breaks;
 * - trailing whitespace after `SELECT`, which the reflow silently swallowed.
 *
 * Nothing here comes from `data/`; the shapes are real, the identifiers are invented.
 */
const AUTHORED_LINES: readonly string[] = [
  "/*",
  "Intent: invented gold — signal quality by weather profile",
  "*/",
  "WITH signal_quality AS (",
  "    -- Step 1: per-signal quality",
  "    SELECT ",
  "        s.signal_registry,",
  "        s.snr_ratio - 0.1 * ABS(s.noise_floor_dbm) AS snqi",
  "    FROM invented_signals s",
  "    JOIN invented_telescopes t ON s.telesc_ref = t.telesc_registry",
  "",
  "    JOIN invented_observatories o ON t.observ_station = o.observ_station",
  ")",
  "-- Step 2: rank within weather profiles",
  "SELECT",
  "    weath_profile,",
  "    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gqi) AS median_gqi,",
  "    COUNT(*) FILTER (WHERE snqi > 0) AS analyzable_signals",
  "FROM signal_quality",
  "GROUP BY weath_profile",
  "ORDER BY median_gqi DESC;",
];

const AUTHORED = AUTHORED_LINES.join("\n");

/** The leading whitespace of a line, as a count. */
function indentOf(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").length;
}

/**
 * Gold's author already formatted it, so the formatter leaves it alone.
 *
 * `deepEqual` is the whole claim here and this fixture is what makes it a claim: under the
 * re-indenting formatter every one of the constructs above came back on a different line, so the
 * assertion fails rather than comparing a value with itself.
 */
test("a statement that already has line breaks is returned exactly as written", () => {
  assert.equal(formatSql(AUTHORED), AUTHORED, "gold's own layout is what the page shows");
});

/**
 * The regression this names, measured rather than restated.
 *
 * `alien_1`'s committed report rendered `    JOIN Telescopes t` above `  ON s.TelescRef = …`, and
 * `PERCENTILE_CONT(0.5) WITHIN GROUP (` above `  ORDER BY gqi) AS median_gqi,`: a continuation
 * indented LESS than the line it was split from, which a reader scans as a new top-level clause.
 * This walks the output rather than comparing it with the input, so it fails for the reason it
 * names even if `deepEqual` above were relaxed.
 */
test("no output line sits shallower than the line it was split from", () => {
  const lines = formatSql(AUTHORED).split("\n");
  const authored = new Set(AUTHORED_LINES);
  const offenders: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const previous = lines[i - 1] ?? "";
    // A line the author wrote is theirs to indent however they like; only lines this function
    // produced are held to the rule, and it produced none of these.
    if (line.trim() === "" || authored.has(line)) continue;
    if (indentOf(line) < indentOf(previous)) offenders.push(`${previous} ⇢ ${line}`);
  }
  assert.deepEqual(offenders, [], `a split line came back shallower:\n${offenders.join("\n")}`);
});

/**
 * The 548-character regression, stated as the number it was.
 *
 * Joining the author's lines and breaking again at clause keywords produced lines LONGER than the
 * source — 548 characters against `alien_5` gold's own longest of 82. Measured against a
 * statement whose own longest line is short, so a reflow of it would blow past the bound.
 */
test("no line of an already-formatted statement grows", () => {
  const longest = (lines: readonly string[]): number => Math.max(...lines.map((l) => l.length));
  const out = formatSql(AUTHORED).split("\n");
  assert.ok(longest(AUTHORED_LINES) < 90, "the fixture's own lines are short enough to bound it");
  assert.ok(
    longest(out) <= longest(AUTHORED_LINES),
    `a line grew: ${longest(out)} > ${longest(AUTHORED_LINES)}`,
  );
  assert.equal(out.length, AUTHORED_LINES.length, "and the line count did not grow either");
});

/**
 * Each construct on its own, so a failure names which one came apart rather than pointing at a
 * twenty-line diff. All three are inline in real gold and all three used to be split.
 */
test("an inline ON, WITHIN GROUP and FILTER are each left on their authored line", () => {
  for (const [name, statement] of [
    ["inline ON", "SELECT a\nFROM t\n    JOIN u ON t.id = u.id"],
    ["WITHIN GROUP", "SELECT\n    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x) AS median\nFROM t"],
    ["FILTER", "SELECT\n    COUNT(*) FILTER (WHERE x > 0) AS usable\nFROM t"],
  ] as const) {
    assert.equal(formatSql(statement), statement, `${name} was re-broken`);
  }
});

test("a joined statement breaks before the join and its ON", () => {
  const lines = formatSql(
    "SELECT a FROM t LEFT OUTER JOIN u ON t.id = u.id UNION ALL SELECT b FROM w",
  ).split("\n");
  assert.ok(lines.includes("LEFT OUTER JOIN u"), lines.join(" | "));
  assert.ok(lines.includes("ON t.id = u.id"), lines.join(" | "));
  assert.ok(lines.includes("UNION ALL"), lines.join(" | "));
});

function withSubmit(semanticSql: string, nativeSql: string | null): RunReportIR {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  return {
    ...base,
    tasks: [
      {
        ...task,
        submits: [
          { attempt: 1, phase: 1, cost: 5, budgetBefore: 18, budgetAfter: 13, semanticSql, nativeSql, result: "3 rows" },
        ],
      },
    ],
  };
}

/**
 * A prefix rendered as the whole submission.
 *
 * `artifacts.ts` writes every trajectory string through `safeText`, which cuts at `PREVIEW_LIMIT`,
 * and nothing downstream can tell a cut string from a short one by looking at it. The ANALYSIS
 * knows: `gradeSubmitted` withdraws every `miss` graded against such a record, because a fragment
 * missing from a prefix may sit past the cut. The page did not, so it printed the prefix under a
 * heading that says this is what the agent submitted — and a reader comparing it against the gold
 * printed directly above reads the missing tail as SQL the agent never wrote.
 */
test("a submission cut at the recording limit is marked as a prefix", () => {
  const cut = `SELECT ${"x".repeat(PREVIEW_LIMIT - 7)}`;
  assert.equal(cut.length, PREVIEW_LIMIT, "the fixture reaches the cut exactly");

  const agentCut = renderReportHtml([withSubmit(cut, "SELECT 1")]);
  assert.match(agentCut, /class="cut"/, "the marker carries its own class");
  assert.match(agentCut, /\.cut\{/, "and the stylesheet knows it");
  assert.match(agentCut, new RegExp(`${PREVIEW_LIMIT}-character`), "it says where the cut is");
  assert.match(agentCut, /prefix/i, "and what that makes the statement");
  assert.equal(agentCut.split(`class="cut"`).length - 1, 1, "one statement was cut, so one marker");

  // The planned statement is recorded through the same writer and gets the same marker.
  const bothCut = renderReportHtml([withSubmit(cut, cut)]);
  assert.equal(bothCut.split(`class="cut"`).length - 1, 2, "both statements were cut");

  // And a statement that fits is not marked: the marker has to mean something.
  const whole = renderReportHtml([withSubmit("SELECT 1", "SELECT 2")]);
  assert.ok(!/class="cut"/.test(whole), "a short submission is the whole of what the agent wrote");
});

test("the page formats the planned SQL and leaves the agent's own SQL as written", () => {
  const semantic = "SELECT a,\n  b\nFROM t\nWHERE a > 1";
  const native = `WITH t AS (SELECT "wren_src_t".a FROM "public".t) SELECT a FROM t WHERE a > 1 ORDER BY a`;
  const html = renderReportHtml([withSubmit(semantic, native)]);
  assert.ok(html.includes(esc(semantic)), "the agent's own formatting is preserved verbatim");
  assert.ok(!html.includes(esc(native)), "the flat planned statement is not rendered as one line");
  assert.ok(html.includes(esc(formatSql(native))), "the planned statement is rendered formatted");
});

// ---------------------------------------------------------------------------
// Gold, and the notice that has to travel with it
// ---------------------------------------------------------------------------

function withGold(goldSql: readonly string[]): RunReportIR {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  return { ...base, tasks: [{ ...task, goldSql }] };
}

test("gold is rendered in the task block, formatted rather than on one line", () => {
  const html = renderReportHtml([report()]);
  assert.ok(html.includes("Ground truth"), "the task block names the section");
  assert.ok(formatSql(GOLD_FLAT).split("\n").length > 1, "the fixture is worth formatting");
  assert.ok(html.includes(esc(formatSql(GOLD_FLAT))), "gold is rendered through the formatter");
  assert.ok(!html.includes(esc(GOLD_FLAT)), "the flat statement is not rendered as written");
});

test("gold sits above the submissions it is there to be compared against", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([
    {
      ...base,
      tasks: [
        {
          ...task,
          submits: [
            { attempt: 1, phase: 1, cost: 5, budgetBefore: 18, budgetAfter: 13, semanticSql: "SELECT hull_class FROM invented_hulls", nativeSql: null, result: "3 rows" },
          ],
        },
      ],
    },
  ]);
  const gold = html.indexOf(esc(formatSql(GOLD_FLAT)));
  const submitted = html.indexOf(esc("SELECT hull_class FROM invented_hulls"));
  assert.ok(gold > -1 && submitted > -1, "both statements are on the page");
  assert.ok(gold < submitted, "gold is read before the submission, not after it");
});

test("gold is escaped like every other interpolated value", () => {
  const risky = `SELECT '<script>alert("x")</script>' AS "a & b" FROM t WHERE q = 'it''s'`;
  const html = renderReportHtml([withGold([risky])]);
  assert.ok(!html.includes("<script>"), "a tag inside gold never reaches the page as markup");
  assert.ok(html.includes(esc(formatSql(risky))), "gold is rendered escaped");
});

test("several gold statements are each rendered and numbered", () => {
  const second = "SELECT COUNT(*) FROM invented_hulls";
  const html = renderReportHtml([withGold([GOLD_FLAT, second])]);
  assert.ok(html.includes(esc(formatSql(GOLD_FLAT))));
  assert.ok(html.includes(esc(formatSql(second))));
  assert.match(html, /Statement 1 of 2/);
  assert.match(html, /Statement 2 of 2/);
});

test("a task with no gold says so instead of rendering an empty block", () => {
  const html = renderReportHtml([withGold([])]);
  assert.match(html, /gold SQL is unknown/i);
  assert.ok(!html.includes(`<pre class="sql"></pre>`), "no empty SQL block is emitted");
});

/**
 * `report.html` is one self-contained file, forwarded without being opened first. The statement has
 * to be above everything a reader would scroll past, not inside the task block that carries gold.
 */
test("the gated notice is on the page, above the sections", () => {
  const html = renderReportHtml([report()]);
  const notice = html.indexOf(esc(GATED_GROUND_TRUTH_NOTICE));
  assert.ok(notice > -1, "the notice the IR carries is rendered");
  assert.ok(notice < html.indexOf(`id="caveats"`), "it precedes the first section");
  assert.ok(notice < html.indexOf(`id="tasks"`), "it precedes the gold it is about");
  assert.match(html, /Gated benchmark material/);
});

/* -------------------------------------------------------------------------- */
/* What the page must not state as a number                                     */
/* -------------------------------------------------------------------------- */

/**
 * `18 / 0` was a task that used more than the whole of a budget it never had.
 *
 * The initial budget lives only in Warble's trace, so a task with no trace has none. Rendering the
 * missing denominator as `0` produced a figure a reader would take as the task having been given
 * nothing to spend.
 */
test("an unknown initial budget renders as unknown, never as a zero denominator", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([
    { ...base, budget: { ...base.budget, initial: null }, tasks: [{ ...task, initialBudget: null }] },
  ]);
  assert.ok(!/18 \/ 0\b/.test(html), "no task row states a zero budget denominator");
  assert.ok(!/18 used of 0\b/.test(html), "and neither does the detail block");
  assert.match(html, /18 \/ <span class="muted">unknown<\/span>/, "the row says the denominator is unknown");
  assert.match(html, /18 used of <span class="muted">unknown<\/span>/);
});

/**
 * A run that measured nothing has no rate. `0 / 0 (0%)` reads as a measured total failure.
 */
test("a zero-task run states that it has no rate rather than printing zero", () => {
  const html = renderReportHtml([
    report({
      strict: {
        totalTasks: 0, totalReward: 0, averageReward: null,
        phase1Count: 0, phase1Rate: null, phase2Count: 0, phase2Rate: null,
      },
      byDifficulty: [],
      byHighLevel: [],
      difficultyVocabularies: [],
      tasks: [],
    }),
  ]);
  assert.ok(!/\(0\.0%\)/.test(html), "no zero percentage is printed for a run with no tasks");
  assert.ok(!/<strong>0\.00<\/strong>/.test(html), "and no zero average reward");
  assert.match(html, /no tasks scored/, "the average says there was nothing to average");
  assert.match(html, /no rate: no tasks/, "and the pass count says there is no rate");
});

/* -------------------------------------------------------------------------- */
/* Which phase a submission and a gold statement belong to                      */
/* -------------------------------------------------------------------------- */

/**
 * A phase-2 submission answers a DIFFERENT question, and the page used to sit it under one
 * "Ground truth" heading beside phase-1 gold with nothing saying so.
 */
test("each submission says which phase it answered", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([
    {
      ...base,
      tasks: [
        {
          ...task,
          submits: [
            { attempt: 1, phase: 1, cost: 3, budgetBefore: 18, budgetAfter: 15, semanticSql: "SELECT 1", nativeSql: null, result: "ok" },
            { attempt: 2, phase: 2, cost: 3, budgetBefore: 15, budgetAfter: 12, semanticSql: "SELECT 2", nativeSql: null, result: "ok" },
            { attempt: 3, phase: null, cost: 3, budgetBefore: 12, budgetAfter: 9, semanticSql: "SELECT 3", nativeSql: null, result: "ok" },
          ],
        },
      ],
    },
  ]);
  assert.match(html, /Attempt 1 · phase 1 ·/);
  assert.match(html, /Attempt 2 · phase 2 ·/);
  assert.match(html, /Attempt 3 · <span class="muted">phase unrecorded<\/span> ·/);
});

test("phase-2 gold is rendered under its own heading, apart from phase 1's", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /Ground truth — phase 1/, "phase 1's gold says which phase it answers");
  assert.match(html, /Ground truth — phase 2 \(follow-up\)/, "and phase 2's has its own heading");
  assert.ok(html.includes(esc(formatSql(FOLLOW_UP_GOLD))), "the follow-up gold is on the page");
  const phase1 = html.indexOf("Ground truth — phase 1");
  const phase2 = html.indexOf("Ground truth — phase 2");
  assert.ok(html.indexOf(esc(formatSql(GOLD_FLAT))) > phase1, "phase-1 gold sits under phase 1");
  assert.ok(html.indexOf(esc(formatSql(FOLLOW_UP_GOLD))) > phase2, "phase-2 gold sits under phase 2");
  assert.match(html, /asks a <strong>different<\/strong> question/i, "and the page says why they differ");
});

test("a task whose row carried no follow-up gold says so instead of showing nothing", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  const html = renderReportHtml([{ ...base, tasks: [{ ...task, followUpGoldSql: [] }] }]);
  assert.match(html, /carried no follow-up gold/i);
  assert.match(html, /Ground truth — phase 2 \(follow-up\)/, "the heading stays, so the gap is visible");
});

/** The grades are phase 1's, and the legend has to say what they were computed against. */
test("the ambiguity legend states that grades are against the last phase-1 submission", () => {
  const html = renderReportHtml([report()]);
  assert.match(html, /last phase-1 submission/i);
  assert.match(html, /a phase-2 submission answers a different question/i);
});

test("the new failure classes render their own labels", () => {
  const base = report();
  const task = base.tasks[0];
  if (task === undefined) throw new Error("the fixture carries a task");
  for (const failureClass of ["no-record", "intent-ungraded"] as const) {
    const cells = taskCells(
      renderReportHtml([{ ...base, tasks: [{ ...task, failureClass }] }]),
      "alien_1",
    );
    assert.equal(cells[CLASS_CELL], esc(CLASS_LABEL[failureClass]), `${failureClass} has no cell`);
  }
});

test("the SQL blocks wrap instead of scrolling sideways", () => {
  const html = renderReportHtml([withSubmit("SELECT 1", "SELECT 1 FROM t")]);
  assert.ok(html.includes(`<pre class="sql">`), "the SQL blocks carry their own class");
  assert.match(html, /pre\.sql\{[^}]*white-space:pre-wrap/);
  assert.match(html, /pre\.sql\{[^}]*word-break/);
});
