import { CLASS_LABEL, type AmbiguityVerdict } from "./report-diagnose.js";
import type { GroupRowIR, RunReportIR, ScoreIR, TaskIR } from "./report-model.js";

/**
 * The report IR rendered as one self-contained page.
 *
 * Pure: no filesystem, no network, and — deliberately — no `Date`. The timestamp arrives on the
 * IR as `generatedAt`, so the same report renders byte-identically every time and a regenerated
 * page diffs to nothing when nothing changed.
 *
 * A withheld run withholds EVERY score, not merely the headline: per-task rewards from a run
 * whose simulator was not answering are exactly as untrustworthy as their average. The page
 * still lists the tasks and everything about them that is not a score, because "which tasks ran,
 * how much budget they burned, and what the dataset said was ambiguous" remains true and useful
 * when the reward does not.
 */

/**
 * Neutralise every HTML metacharacter.
 *
 * `&` goes first: escaping it after the others would rewrite the `&` of `&lt;` and double-escape
 * the whole document.
 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A count or a duration: integers stay integral, fractions keep at most two places. */
function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** A reward, always to two places, so a column of them lines up. */
function scoreOf(value: number): string {
  return value.toFixed(2);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

const DASH = `<span class="muted">—</span>`;
const HELD = `<span class="held">withheld</span>`;
const UNCOMPUTED = `not computed — run <code>just autopsy-bird-eval</code>`;

function passFail(passed: boolean): string {
  return passed ? `<span class="pass">pass</span>` : `<span class="fail">fail</span>`;
}

function list(values: readonly string[]): string {
  if (values.length === 0) return "";
  return `<ul>${values.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`;
}

function numbers(values: readonly number[]): string {
  return values.length === 0 ? DASH : esc(values.join(", "));
}

function tableOf(head: string, body: string): string {
  return `<div class="scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** Per-run blocks, headed only when there is more than one run to tell apart. */
function perRun(reports: readonly RunReportIR[], render: (r: RunReportIR) => string): string {
  return reports
    .map((r) => {
      const block = render(r);
      if (block === "") return "";
      return reports.length > 1 ? `<h4>${esc(r.provenance.run)}</h4>${block}` : block;
    })
    .filter((s) => s !== "")
    .join("");
}

// ---------------------------------------------------------------------------
// Before comparing these
// ---------------------------------------------------------------------------

const PROVENANCE_FIELDS: readonly { readonly label: string; readonly cell: (r: RunReportIR) => string }[] = [
  { label: "Run", cell: (r) => esc(r.provenance.run) },
  { label: "System agent", cell: (r) => `<code>${esc(r.provenance.systemModel)}</code>` },
  {
    label: "User simulator",
    cell: (r) =>
      r.provenance.userSimulatorModel === null
        ? `<span class="muted">unrecorded</span>`
        : `<code>${esc(r.provenance.userSimulatorModel)}</code>`,
  },
  { label: "Official commit", cell: (r) => `<code>${esc(r.provenance.officialCommit)}</code>` },
  { label: "Public snapshot", cell: (r) => `<code>${esc(r.provenance.publicSnapshotCommit)}</code>` },
  { label: "Image", cell: (r) => `<code>${esc(r.provenance.imageId)}</code>` },
  {
    label: "Repo digests",
    cell: (r) =>
      r.provenance.repoDigests.length === 0
        ? DASH
        : r.provenance.repoDigests.map((d) => `<code>${esc(d)}</code>`).join("<br>"),
  },
  { label: "Wren", cell: (r) => esc(r.provenance.wrenVersion) },
  { label: "Python", cell: (r) => esc(r.provenance.pythonVersion) },
  {
    label: "Tasks",
    cell: (r) =>
      `${esc(num(r.provenance.taskIds.length))} — <span class="ids">${esc(r.provenance.taskIds.join(", "))}</span>`,
  },
];

function caveatsSection(reports: readonly RunReportIR[]): string {
  const head = `<tr><th>Provenance</th>${reports.map((r) => `<th scope="col">${esc(r.provenance.run)}</th>`).join("")}</tr>`;
  const body = PROVENANCE_FIELDS.map(
    (f) => `<tr><th scope="row">${esc(f.label)}</th>${reports.map((r) => `<td>${f.cell(r)}</td>`).join("")}</tr>`,
  ).join("");

  const warnings = perRun(reports, (r) => list(r.warnings));
  const anyDefect = reports.some((r) => r.defects.length > 0);
  const defects = anyDefect
    ? `<h3>Defects</h3><p class="note">Where the official record and Warble's own trace disagree. A number is not trustworthy while these stand.</p>${perRun(
        reports,
        (r) => list(r.defects),
      )}`
    : "";

  return `<section id="caveats"><h2>Before comparing these</h2>
${warnings === "" ? `<p class="muted">No comparability warnings were recorded.</p>` : warnings}
${defects}
<h3>Provenance</h3>
<p class="note">A reported score that cannot say what produced it is not reportable.</p>
${tableOf(head, body)}
</section>`;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

function simulatorSection(reports: readonly RunReportIR[]): string {
  const head = `<tr><th scope="col">Run</th><th scope="col">Verdict</th><th scope="col">Asks</th><th scope="col">Canned answers</th><th scope="col">LLM call failures</th></tr>`;
  const body = reports
    .map((r) => {
      const s = r.simulator;
      return `<tr><th scope="row">${esc(r.provenance.run)}</th><td><span class="verdict ${esc(s.verdict)}">${esc(s.verdict)}</span></td><td>${esc(num(s.asks))}</td><td>${esc(num(s.cannedResponses))}</td><td>${esc(num(s.llmCallFailures))}</td></tr>`;
    })
    .join("");
  return `<section id="simulator"><h2>Simulator</h2>
<p class="note">The benchmark deletes one required knowledge entry per task, and <code>ask_user</code> is the only route back to it. A simulator that answered nothing is indistinguishable from a weak agent unless something looks — a <code>void</code> verdict withholds that run's scores rather than reporting a number a reader could quote.</p>
${tableOf(head, body)}
</section>`;
}

// ---------------------------------------------------------------------------
// Reward
// ---------------------------------------------------------------------------

interface Metric {
  readonly label: string;
  readonly cell: (r: RunReportIR) => string;
}

function strictCell(r: RunReportIR, render: (s: ScoreIR) => string): string {
  if (r.withheld !== null) return HELD;
  return r.strict === null ? DASH : render(r.strict);
}

function tolerantCell(r: RunReportIR, render: (s: ScoreIR) => string): string {
  if (r.withheld !== null) return HELD;
  return r.tolerant === null ? `<span class="muted">${UNCOMPUTED}</span>` : render(r.tolerant);
}

function outOf(count: number, total: number, rate: number): string {
  return `${esc(num(count))} / ${esc(num(total))} <span class="muted">(${esc(percent(rate))})</span>`;
}

const METRICS: readonly Metric[] = [
  { label: "Tasks", cell: (r) => esc(num(r.strict === null ? r.tasks.length : r.strict.totalTasks)) },
  { label: "Average reward (strict)", cell: (r) => strictCell(r, (s) => `<strong>${esc(scoreOf(s.averageReward))}</strong>`) },
  { label: "Total reward (strict)", cell: (r) => strictCell(r, (s) => esc(num(s.totalReward))) },
  { label: "Phase 1 passed (strict)", cell: (r) => strictCell(r, (s) => outOf(s.phase1Count, s.totalTasks, s.phase1Rate)) },
  { label: "Phase 2 passed (strict)", cell: (r) => strictCell(r, (s) => outOf(s.phase2Count, s.totalTasks, s.phase2Rate)) },
  { label: "Average reward (tolerant)", cell: (r) => tolerantCell(r, (s) => esc(scoreOf(s.averageReward))) },
  { label: "Phase 1 passed (tolerant)", cell: (r) => tolerantCell(r, (s) => outOf(s.phase1Count, s.totalTasks, s.phase1Rate)) },
  { label: "Phase 2 passed (tolerant)", cell: (r) => tolerantCell(r, (s) => outOf(s.phase2Count, s.totalTasks, s.phase2Rate)) },
];

function rewardSection(reports: readonly RunReportIR[]): string {
  const notes = reports
    .filter((r) => r.withheld !== null)
    .map(
      (r) =>
        `<p class="held-note"><strong>Scores withheld — ${esc(r.provenance.run)}.</strong> ${esc(r.withheld)}</p>`,
    )
    .join("");

  const scorable = reports.some((r) => r.withheld === null);
  const table = scorable
    ? tableOf(
        `<tr><th></th>${reports.map((r) => `<th scope="col">${esc(r.provenance.run)}</th>`).join("")}</tr>`,
        METRICS.map(
          (m) =>
            `<tr><th scope="row">${esc(m.label)}</th>${reports.map((r) => `<td>${m.cell(r)}</td>`).join("")}</tr>`,
        ).join(""),
      ) +
      `<p class="note">Tolerant never appears without strict beside it. It answers the weaker question — did the run compute the right numbers, whatever shape they came out in — and is not a substitute headline.</p>`
    : "";

  return `<section id="reward"><h2>Reward</h2>
${notes}
${table}
</section>`;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function budgetSection(reports: readonly RunReportIR[]): string {
  const head = `<tr><th scope="col">Run</th><th scope="col">Budget used</th><th scope="col">Initial budget</th><th scope="col">Used</th><th scope="col">Tasks that ran out</th></tr>`;
  const body = reports
    .map((r) => {
      const b = r.budget;
      const share = b.initial > 0 ? esc(percent(b.used / b.initial)) : DASH;
      return `<tr><th scope="row">${esc(r.provenance.run)}</th><td>${esc(num(b.used))}</td><td>${esc(num(b.initial))}</td><td>${share}</td><td>${esc(num(b.exhaustedTasks))}</td></tr>`;
    })
    .join("");
  return `<section id="budget"><h2>Budget</h2>
<p class="note">A task that ended with its budget exhausted and no passing phase ran out of room to find the answer; that is not the same failure as a wrong answer, and the reward cannot express the difference.</p>
${tableOf(head, body)}
</section>`;
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

function groupTable(
  reports: readonly RunReportIR[],
  keyHeader: string,
  pick: (r: RunReportIR) => readonly GroupRowIR[],
): string {
  const keys: string[] = [];
  for (const r of reports) {
    for (const row of pick(r)) if (!keys.includes(row.key)) keys.push(row.key);
  }
  if (keys.length === 0) return `<p class="muted">No rows.</p>`;

  const multi = reports.length > 1;
  const head = multi
    ? `<tr><th scope="col" rowspan="2">${esc(keyHeader)}</th>${reports
        .map((r) => `<th scope="colgroup" colspan="3">${esc(r.provenance.run)}</th>`)
        .join("")}</tr><tr>${reports
        .map(() => `<th scope="col">Tasks</th><th scope="col">Average reward</th><th scope="col">Phase 1 passed</th>`)
        .join("")}</tr>`
    : `<tr><th scope="col">${esc(keyHeader)}</th><th scope="col">Tasks</th><th scope="col">Average reward</th><th scope="col">Phase 1 passed</th></tr>`;

  const body = keys
    .map((key) => {
      const cells = reports
        .map((r) => {
          const row = pick(r).find((g) => g.key === key);
          if (row === undefined) return `<td>${DASH}</td><td>${DASH}</td><td>${DASH}</td>`;
          const held = r.withheld !== null;
          return `<td>${esc(num(row.tasks))}</td><td>${held ? HELD : esc(scoreOf(row.averageReward))}</td><td>${held ? HELD : esc(num(row.phase1Count))}</td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(key)}</th>${cells}</tr>`;
    })
    .join("");

  return tableOf(head, body);
}

function difficultySection(reports: readonly RunReportIR[]): string {
  const vocabularies: string[] = [];
  for (const r of reports) {
    for (const v of r.difficultyVocabularies) if (!vocabularies.includes(v)) vocabularies.push(v);
  }
  const split = reports.some((r) => r.difficultyVocabularies.length > 1);
  const note = split
    ? `<p class="note"><strong>This dataset carries more than one difficulty vocabulary</strong> — present here: ${esc(
        vocabularies.join(", "),
      )}. The rows below are the dataset's own labels and are <strong>not merged</strong>: the mapping between the vocabularies is an assumption this report has no authority to make.</p>`
    : "";
  return `<section id="by-difficulty"><h2>By difficulty</h2>
${note}
${groupTable(reports, "Difficulty", (r) => r.byDifficulty)}
</section>`;
}

function questionLevelSection(reports: readonly RunReportIR[]): string {
  return `<section id="by-question-level"><h2>By question level</h2>
<p class="note">A high-level question states a goal; the rest state the query. They are different asks and the split says which one the run struggled with.</p>
${groupTable(reports, "High level", (r) => r.byHighLevel)}
</section>`;
}

// ---------------------------------------------------------------------------
// Wren-planned SQL
// ---------------------------------------------------------------------------

/**
 * One token of a SQL statement, with the whitespace that preceded it.
 *
 * `gap` is whitespace-only by construction, and `formatPlannedSql` proves it by rebuilding its
 * input from these pieces before it reformats anything.
 */
interface SqlToken {
  readonly text: string;
  readonly gap: string;
}

const WORD_TOKEN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;
const DOLLAR_TAG = /^\$[A-Za-z_0-9]*\$/;

/**
 * Split a statement into tokens and the whitespace between them.
 *
 * String literals, quoted identifiers, dollar-quoted bodies and comments are each ONE token and
 * are never looked inside. That is what keeps `WHERE x = 'SELECT FROM'` a value rather than a
 * clause, and what keeps a parenthesis inside a literal out of the indentation depth. An
 * unterminated literal — the stored plan is truncated at a fixed length — runs to the end of the
 * input as a single token rather than raising or looping.
 */
function lexSql(sql: string): { readonly tokens: readonly SqlToken[]; readonly trailing: string } {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const gapStart = i;
    while (i < sql.length && SPACE.test(sql.charAt(i))) i += 1;
    const gap = sql.slice(gapStart, i);
    if (i >= sql.length) return { tokens, trailing: gap };

    const start = i;
    const c = sql.charAt(i);
    if (c === "'" || c === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql.charAt(i) !== c) {
          i += 1;
          continue;
        }
        // A doubled quote is an escaped quote, not the end of the literal.
        if (sql.charAt(i + 1) === c) {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
    } else if (c === "$") {
      const tag = DOLLAR_TAG.exec(sql.slice(i));
      const opener = tag === null ? null : tag[0];
      if (opener === undefined || opener === null) {
        i += 1;
      } else {
        const close = sql.indexOf(opener, i + opener.length);
        i = close === -1 ? sql.length : close + opener.length;
      }
    } else if (c === "-" && sql.charAt(i + 1) === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i += 1;
    } else if (c === "/" && sql.charAt(i + 1) === "*") {
      i += 2;
      while (i < sql.length && !(sql.charAt(i) === "*" && sql.charAt(i + 1) === "/")) i += 1;
      i = Math.min(i + 2, sql.length);
    } else if (WORD_START.test(c)) {
      while (i < sql.length && WORD_PART.test(sql.charAt(i))) i += 1;
    } else if (DIGIT.test(c)) {
      while (i < sql.length && DIGIT.test(sql.charAt(i))) i += 1;
    } else {
      i += 1;
    }
    tokens.push({ text: sql.slice(start, i), gap });
  }
  return { tokens, trailing: "" };
}

/**
 * The clause keywords a line breaks before, longest phrase first so `LEFT OUTER JOIN` is one
 * break rather than three and `UNION ALL` keeps its `ALL`.
 */
const BREAK_PHRASES: readonly (readonly string[])[] = [
  ["LEFT", "OUTER", "JOIN"],
  ["RIGHT", "OUTER", "JOIN"],
  ["FULL", "OUTER", "JOIN"],
  ["LEFT", "JOIN"],
  ["RIGHT", "JOIN"],
  ["FULL", "JOIN"],
  ["INNER", "JOIN"],
  ["CROSS", "JOIN"],
  ["NATURAL", "JOIN"],
  ["UNION", "ALL"],
  ["GROUP", "BY"],
  ["ORDER", "BY"],
  ["WITH"],
  ["SELECT"],
  ["FROM"],
  ["WHERE"],
  ["HAVING"],
  ["LIMIT"],
  ["UNION"],
  ["JOIN"],
  ["ON"],
];

/** How many tokens of a break phrase start at `i`, or 0. */
function matchPhrase(tokens: readonly SqlToken[], i: number): number {
  for (const phrase of BREAK_PHRASES) {
    let matched = true;
    for (let k = 0; k < phrase.length; k += 1) {
      const token = tokens[i + k];
      const want = phrase[k];
      // A quoted identifier keeps its quotes in `text`, so `"SELECT"` never matches `SELECT`.
      if (token === undefined || want === undefined || !WORD_TOKEN.test(token.text) || token.text.toUpperCase() !== want) {
        matched = false;
        break;
      }
    }
    if (matched) return phrase.length;
  }
  return 0;
}

const SQL_INDENT = "  ";

/**
 * Pretty-print the SQL Wren planned.
 *
 * Wren emits its plan as one flat line — 778 characters in this run's shortest case — so the page
 * showed a horizontal scrollbar and no structure. This breaks before each major clause keyword at
 * the position it occurs and indents by parenthesis depth, so nested subqueries are visible. It
 * does not align, split expressions, or change any letter's case: a modest formatter that is
 * obviously right beats a clever one, because this is a record of what Wren produced.
 *
 * The invariant, and the reason reformatting the record is honest at all: the ONLY thing this
 * changes is whitespace BETWEEN tokens. Tokens are emitted verbatim in their original order, so
 * no character inside a literal or identifier can move. The statement is rebuilt from the lexer's
 * own pieces first, and anything that does not reconstruct byte-for-byte is returned untouched.
 *
 * Applied to `nativeSql` only. `semanticSql` is what the agent itself wrote, and reformatting
 * that would misrepresent the agent's output.
 */
export function formatPlannedSql(sql: string): string {
  const { tokens, trailing } = lexSql(sql);
  let rebuilt = "";
  for (const token of tokens) rebuilt += token.gap + token.text;
  if (rebuilt + trailing !== sql) return sql;

  const lines: string[] = [];
  let line = "";
  let filled = false;
  let depth = 0;
  let i = 0;

  while (i < tokens.length) {
    const phrase = matchPhrase(tokens, i);
    if (phrase > 0 && filled) {
      lines.push(line);
      line = SQL_INDENT.repeat(depth);
      filled = false;
    }
    const span = phrase > 0 ? phrase : 1;
    for (let k = 0; k < span; k += 1) {
      const token = tokens[i + k];
      if (token === undefined) break;
      // Adjacency is never invented: `ROUND(` and `AS (` keep whatever the plan chose.
      if (filled && token.gap !== "") line += " ";
      line += token.text;
      filled = true;
      if (token.text === "(") depth += 1;
      else if (token.text === ")" && depth > 0) depth -= 1;
      // A line comment swallows whatever follows it on the same line.
      if (token.text.startsWith("--")) {
        lines.push(line);
        line = SQL_INDENT.repeat(depth);
        filled = false;
      }
    }
    i += span;
  }
  if (filled) lines.push(line);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function ambiguityCell(verdicts: readonly AmbiguityVerdict[]): string {
  if (verdicts.length === 0) return `<span class="muted">none recorded</span>`;
  return verdicts
    .map(
      (a) =>
        `<span class="amb ${esc(a.match)}" title="${esc(a.type)}">${esc(a.term)}<span class="amb-tag">${esc(
          a.match,
        )}${a.critical ? " · critical" : ""}${a.isMask ? " · withheld entry" : ""}</span></span>`,
    )
    .join(" ");
}

function taskRow(task: TaskIR, held: boolean): string {
  const tolerant =
    task.tolerantPassed === null ? `<span class="muted">not measured</span>` : passFail(task.tolerantPassed);
  return `<tr>
<th scope="row"><code>${esc(task.taskId)}</code></th>
<td>${esc(task.category)}</td>
<td>${esc(task.difficultyTier)}</td>
<td>${held ? HELD : `<strong>${esc(scoreOf(task.reward))}</strong>`}</td>
<td>${held ? HELD : passFail(task.phase1Passed)}</td>
<td>${held ? HELD : passFail(task.phase2Passed)}</td>
<td>${held ? HELD : tolerant}</td>
<td>${esc(num(task.budgetUsed))} / ${esc(num(task.initialBudget))}</td>
<td>${esc(CLASS_LABEL[task.failureClass])}</td>
<td>${ambiguityCell(task.ambiguities)}</td>
</tr>`;
}

function taskDetail(task: TaskIR): string {
  const tools = Object.entries(task.toolCalls);
  const toolRow =
    tools.length === 0
      ? DASH
      : tools.map(([name, calls]) => `<code>${esc(name)}</code> ×${esc(num(calls))}`).join(", ");

  const asks =
    task.asks.length === 0
      ? `<p class="muted">No questions were asked.</p>`
      : task.asks
          .map(
            (a) =>
              `<div class="ask"><p class="q">${esc(a.question)}</p><p class="a">${esc(a.answer)}</p>${
                a.canned ? `<p class="canned">the simulator returned its canned non-answer</p>` : ""
              }</div>`,
          )
          .join("");

  const submits =
    task.submits.length === 0
      ? `<p class="muted">Nothing was submitted.</p>`
      : task.submits
          .map(
            (s) =>
              `<div class="submit"><p class="meta">Attempt ${esc(num(s.attempt))} · cost ${esc(
                num(s.cost),
              )} · budget ${esc(num(s.budgetBefore))} → ${esc(num(s.budgetAfter))}</p><pre class="sql">${esc(
                s.semanticSql,
              )}</pre>${s.nativeSql === null ? "" : `<p class="meta">Wren planned:</p><pre class="sql">${esc(formatPlannedSql(s.nativeSql))}</pre>`}<p class="result">${esc(
                s.result,
              )}</p></div>`,
          )
          .join("");

  const k = task.knowledge;
  return `<details><summary><code>${esc(task.taskId)}</code> — ${esc(task.category)} · ${esc(
    task.difficultyTier,
  )}</summary>
<dl>
<dt>Database</dt><dd>${esc(task.database)}</dd>
<dt>High level</dt><dd>${task.highLevel ? "yes" : "no"}</dd>
<dt>Budget</dt><dd>${esc(num(task.budgetUsed))} used of ${esc(num(task.initialBudget))}, ${esc(
    num(task.budgetRemaining),
  )} left</dd>
<dt>Model turns</dt><dd>${esc(num(task.modelTurns))}</dd>
<dt>Elapsed</dt><dd>${esc(num(task.elapsedSeconds))} s</dd>
<dt>Tool calls</dt><dd>${toolRow}</dd>
<dt>Knowledge required</dt><dd>${numbers(k.required)}</dd>
<dt>Knowledge withheld by the task</dt><dd>${numbers(k.withheld)}</dd>
<dt>Recovered by asking</dt><dd>${numbers(k.recovered)}</dd>
<dt>Never obtained</dt><dd>${numbers(k.missed)}</dd>
</dl>
<h5>Asks</h5>${asks}
<h5>Submissions</h5>${submits}
</details>`;
}

function tasksSection(reports: readonly RunReportIR[]): string {
  const head = `<tr><th scope="col">Task</th><th scope="col">Category</th><th scope="col">Difficulty</th><th scope="col">Reward</th><th scope="col">Phase 1</th><th scope="col">Phase 2</th><th scope="col">Tolerant</th><th scope="col">Budget</th><th scope="col">Why it landed there</th><th scope="col">Ambiguities</th></tr>`;

  const anyHeld = reports.some((r) => r.withheld !== null);
  const held = anyHeld
    ? `<p class="note">Cells marked <span class="held">withheld</span> are suppressed for the same reason the headline is: a run whose simulator was not answering produces per-task rewards no more trustworthy than their average. Everything else about the task is unaffected and is reported.</p>`
    : "";

  const blocks = perRun(reports, (r) => {
    if (r.tasks.length === 0) return `<p class="muted">No tasks.</p>`;
    const body = r.tasks.map((t) => taskRow(t, r.withheld !== null)).join("");
    const details = r.tasks.map((t) => taskDetail(t)).join("");
    return `${tableOf(head, body)}<h4 class="detail-head">Trace</h4>${details}`;
  });

  return `<section id="tasks"><h2>Tasks</h2>
${held}
${blocks}
</section>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1c1b19;--muted:#6d6b66;--line:#e4e1da;--panel:#ffffff;--accent:#8a4b1c;--held:#8a5a00;--bad:#a32c2c;--good:#1e6b3f}
@media (prefers-color-scheme:dark){:root{--bg:#16171b;--fg:#e9e7e2;--muted:#9a988f;--line:#2d2f36;--panel:#1c1e23;--accent:#e0a76a;--held:#d8a441;--bad:#e28c8c;--good:#7fc79b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:74rem;margin:0 auto;padding:2rem 1.25rem 5rem}
h1{font-size:1.6rem;margin:0 0 .35rem}
h2{font-size:1.2rem;margin:0 0 .75rem;padding-bottom:.4rem;border-bottom:2px solid var(--line)}
h3{font-size:1rem;margin:1.4rem 0 .5rem}
h4{font-size:.92rem;margin:1.1rem 0 .45rem;color:var(--accent)}
h5{font-size:.85rem;margin:.9rem 0 .35rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
section{margin:0 0 2.4rem}
p{margin:.5rem 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
.sub{color:var(--muted);margin:0 0 1.6rem}
.note{color:var(--muted);font-size:.9rem;max-width:60rem}
.muted{color:var(--muted)}
.ids{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82em}
.scroll{overflow-x:auto;margin:.6rem 0 .3rem}
table{border-collapse:collapse;width:100%;font-size:.9rem;background:var(--panel);border:1px solid var(--line)}
th,td{text-align:left;padding:.42rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
thead th{background:var(--bg);font-weight:600;white-space:nowrap}
tbody th{font-weight:600;white-space:nowrap}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
ul{margin:.5rem 0;padding-left:1.2rem}
li{margin:.2rem 0}
.pass{color:var(--good);font-weight:600}
.fail{color:var(--bad);font-weight:600}
.held{color:var(--held);font-weight:600;font-style:italic}
.held-note{border-left:4px solid var(--held);background:var(--panel);padding:.7rem .9rem;margin:.6rem 0}
.verdict{font-weight:600}
.verdict.healthy{color:var(--good)}
.verdict.degraded{color:var(--held)}
.verdict.void{color:var(--bad)}
.amb{display:inline-block;border:1px solid var(--line);border-radius:.5rem;padding:.05rem .4rem;margin:.1rem .15rem .1rem 0;font-size:.84rem}
.amb.miss{border-color:var(--bad)}
.amb.exact{border-color:var(--good)}
.amb-tag{color:var(--muted);margin-left:.35rem;font-size:.78rem}
details{border:1px solid var(--line);border-radius:.4rem;background:var(--panel);padding:.45rem .7rem;margin:.4rem 0}
summary{cursor:pointer;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem .8rem;margin:.6rem 0;font-size:.88rem}
dt{color:var(--muted)}
dd{margin:0}
pre{overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:.35rem;padding:.5rem .6rem;font-size:.82rem;margin:.35rem 0}
pre.sql{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.ask,.submit{border-left:3px solid var(--line);padding-left:.7rem;margin:.5rem 0}
.ask .q{font-weight:600;margin:.15rem 0}
.ask .a,.result{color:var(--muted);font-size:.88rem;margin:.15rem 0}
.canned{color:var(--bad);font-size:.85rem;margin:.15rem 0}
.submit .meta{color:var(--muted);font-size:.84rem;margin:.15rem 0}
.detail-head{margin-top:1rem}
`;

/**
 * Render one or more report IRs as a single self-contained page.
 *
 * More than one report makes the page a comparison: the score, budget, simulator and breakdown
 * tables grow a column per run, and each run keeps its own task table below.
 */
export function renderReportHtml(reports: readonly RunReportIR[]): string {
  const runs = reports.map((r) => r.provenance.run);
  const title = runs.length === 0 ? "BIRD-Interact report" : `BIRD-Interact report — ${runs.join(" vs ")}`;
  const first = reports[0];
  const generatedAt = first === undefined ? "" : first.generatedAt;
  const stamp =
    generatedAt === "" ? "" : `<p class="sub">Generated ${esc(generatedAt)} · ${esc(runs.join(" · "))}</p>`;

  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${esc(title)}</h1>`,
    stamp,
    caveatsSection(reports),
    simulatorSection(reports),
    rewardSection(reports),
    budgetSection(reports),
    difficultySection(reports),
    questionLevelSection(reports),
    tasksSection(reports),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
