import assert from "node:assert/strict";
import test from "node:test";

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
  `-- the invented gold: hull classes by count\nWITH q AS (SELECT hull_class FROM invented_hulls WHERE scanned) SELECT hull_class, COUNT(*) AS n FROM q GROUP BY hull_class ORDER BY n DESC`;

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
      toolCalls: { submit_sql: 3 }, goldSql: [GOLD_FLAT], submits: [], asks: [],
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
      { ...task, reward: null, phase1Passed: null, phase2Passed: null, tolerantPassed: null, failureClass: null },
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
      { ...task, reward: null, phase1Passed: null, phase2Passed: null, tolerantPassed: null, failureClass: null },
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
 * An invented statement laid out the way the benchmark lays gold out: a leading comment, a column
 * per line, and an indented `ON`. Nothing here comes from `data/`.
 */
const AUTHORED_LINES: readonly string[] = [
  "-- invented gold: average load per hull class",
  "SELECT",
  "  h.hull_class,",
  "  AVG(h.mass_kg - 0.25 * ABS(h.drift_kg)) AS avg_load",
  "FROM invented_hulls h",
  "JOIN invented_scans s",
  "  ON s.hull_ref = h.hull_id",
  "",
  "GROUP BY h.hull_class",
  "ORDER BY avg_load DESC",
];

/**
 * The formatter only ever ADDS breaks.
 *
 * Reflowing an already-formatted statement is not a neutral act: joining the author's lines and
 * breaking again at clause keywords produced lines LONGER than the source — 548 characters against
 * `alien_5` gold's own longest of 82 — which is the opposite of what formatting is for.
 */
test("a statement that already has line breaks keeps them, and no line grows", () => {
  const authored = AUTHORED_LINES.join("\n");
  const out = formatSql(authored).split("\n");
  assert.deepEqual(out, [...AUTHORED_LINES], "every authored line survives, in order and verbatim");
  const longest = (lines: readonly string[]): number => Math.max(...lines.map((l) => l.length));
  assert.ok(
    longest(out) <= longest(AUTHORED_LINES),
    `a line grew: ${longest(out)} > ${longest(AUTHORED_LINES)}`,
  );
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
          { attempt: 1, cost: 5, budgetBefore: 18, budgetAfter: 13, semanticSql, nativeSql, result: "3 rows" },
        ],
      },
    ],
  };
}

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
            { attempt: 1, cost: 5, budgetBefore: 18, budgetAfter: 13, semanticSql: "SELECT hull_class FROM invented_hulls", nativeSql: null, result: "3 rows" },
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

test("the SQL blocks wrap instead of scrolling sideways", () => {
  const html = renderReportHtml([withSubmit("SELECT 1", "SELECT 1 FROM t")]);
  assert.ok(html.includes(`<pre class="sql">`), "the SQL blocks carry their own class");
  assert.match(html, /pre\.sql\{[^}]*white-space:pre-wrap/);
  assert.match(html, /pre\.sql\{[^}]*word-break/);
});
