import assert from "node:assert/strict";
import test from "node:test";

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
    simulator: { llmCallFailures: 0, asks: 1, cannedResponses: 0, verdict: "healthy" },
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

test("a withheld run renders the reason and never the number", () => {
  const html = renderReportHtml([
    report({ strict: null, tolerant: null, withheld: "the user simulator answered nothing", simulator: { llmCallFailures: 3, asks: 5, cannedResponses: 5, verdict: "void" } }),
  ]);
  assert.ok(html.includes("the user simulator answered nothing"));
  assert.ok(!/average_?[Rr]eward|0\.00/.test(html), "a void run must not render a score");
});

test("an uncomputed tolerant column says so instead of rendering blank", () => {
  assert.match(renderReportHtml([report()]), /not computed/i);
});

test("a computed tolerant score renders beside strict", () => {
  const html = renderReportHtml([
    report({ tolerant: { totalTasks: 1, totalReward: 1, averageReward: 1, phase1Count: 1, phase1Rate: 1, phase2Count: 0, phase2Rate: 0 } }),
  ]);
  assert.ok(html.includes("tolerant") || html.includes("Tolerant"));
  assert.ok(!/not computed/i.test(html));
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
