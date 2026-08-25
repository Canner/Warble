import { looksTruncated, PREVIEW_LIMIT } from "./preview-truncation.js";
import { CLASS_LABEL, type AmbiguityVerdict } from "./report-diagnose.js";
import type {
  GroupRowIR,
  KnowledgeIR,
  RunReportIR,
  ScoreIR,
  SubmitIR,
  TaskIR,
  TolerantScoreIR,
} from "./report-model.js";

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
 *
 * **The suppression is read off the IR, never decided here.** Each masked cell renders `withheld`
 * because the field it renders is `null`, which `buildRunReport` made it and the schema refuses to
 * let a withheld report state any other way. A renderer that decided this for itself is how the
 * recorded VOID run came to print a per-task failure class beside its own withheld reward cells —
 * the reward it masked and the verdict it published were the same claim about the same task.
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
/**
 * The denominator of a budget nothing recorded.
 *
 * The initial budget lives only in Warble's trace, so a task with no trace has none. It used to
 * render `18 / 0` — a task that used more than the whole of a budget it never had, and a number a
 * reader would take as the task having been given nothing.
 */
const UNKNOWN_BUDGET = `<span class="muted">unknown</span>`;

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

/**
 * A per-id knowledge verdict, or the sentence saying the report could not reach one.
 *
 * `null` must not render as the dash an empty list prints. The dash reads as "the report looked and
 * found none" — a per-id claim the producer refuses to make, because it reads no knowledge base and
 * so cannot tie any answer to any id once the ask channel came back open. See `KnowledgeIR`.
 */
function knowledgeIds(values: readonly number[] | null): string {
  return values === null
    ? `<span class="muted">not determined — this report reads no knowledge base</span>`
    : numbers(values);
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
  const head = `<tr><th scope="col">Run</th><th scope="col">Verdict</th><th scope="col">Asks attempted</th><th scope="col">Answered</th><th scope="col">Canned answers</th><th scope="col">LLM call failures</th></tr>`;
  const body = reports
    .map((r) => {
      const s = r.simulator;
      return `<tr><th scope="row">${esc(r.provenance.run)}</th><td><span class="verdict ${esc(s.verdict)}">${esc(s.verdict)}</span></td><td>${esc(num(s.asks))}</td><td>${esc(num(s.answered))}</td><td>${esc(num(s.cannedResponses))}</td><td>${esc(num(s.llmCallFailures))}</td></tr>`;
    })
    .join("");
  return `<section id="simulator"><h2>Simulator</h2>
<p class="note">The benchmark deletes one required knowledge entry per task, and <code>ask_user</code> is the only route back to it. A simulator that answered nothing is indistinguishable from a weak agent unless something looks — a <code>void</code> verdict withholds that run's scores rather than reporting a number a reader could quote. <strong>Asks attempted</strong> counts the charged <code>ask_user</code> calls, including the ones that errored and left no answer behind; an attempted ask that came back with nothing is evidence the simulator did not answer, and is graded as such.</p>
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

function tolerantCell(r: RunReportIR, render: (s: TolerantScoreIR) => string): string {
  if (r.withheld !== null) return HELD;
  return r.tolerant === null ? `<span class="muted">${UNCOMPUTED}</span>` : render(r.tolerant);
}

/**
 * A count out of a total, and the share it is — or the statement that there is no share.
 *
 * A `null` rate means the run scored no tasks, so the quotient does not exist. It renders as the
 * words rather than as `0%`: `0 / 0 (0%)` reads as a measured failure, and the run measured
 * nothing at all. The IR is what decides this; see `ScoreIR`.
 */
function outOf(count: number, total: number, rate: number | null): string {
  const share =
    rate === null ? `<span class="muted">(no rate: no tasks)</span>` : `<span class="muted">(${esc(percent(rate))})</span>`;
  return `${esc(num(count))} / ${esc(num(total))} ${share}`;
}

/** What a quotient over zero tasks renders as, wherever one would have gone. */
const NO_RATE = `<span class="muted">no tasks scored</span>`;

const METRICS: readonly Metric[] = [
  { label: "Tasks", cell: (r) => esc(num(r.strict === null ? r.tasks.length : r.strict.totalTasks)) },
  {
    label: "Average reward (strict)",
    cell: (r) =>
      strictCell(r, (s) =>
        s.averageReward === null ? NO_RATE : `<strong>${esc(scoreOf(s.averageReward))}</strong>`,
      ),
  },
  { label: "Total reward (strict)", cell: (r) => strictCell(r, (s) => esc(num(s.totalReward))) },
  { label: "Phase 1 passed (strict)", cell: (r) => strictCell(r, (s) => outOf(s.phase1Count, s.totalTasks, s.phase1Rate)) },
  { label: "Phase 2 passed (strict)", cell: (r) => strictCell(r, (s) => outOf(s.phase2Count, s.totalTasks, s.phase2Rate)) },
  // Tolerant has no reward row, and cannot: it counts tasks. The row that used to sit here was
  // labelled "Average reward (tolerant)" and carried the pass RATE, one line under strict's
  // genuine reward average — 0.60 against 0.20, read by anyone as a 3x improvement in one quantity.
  { label: "Tasks passed phase 1 (tolerant)", cell: (r) => tolerantCell(r, (s) => outOf(s.phase1Count, s.totalTasks, s.phase1Rate)) },
  { label: "Tasks passed phase 2 (tolerant)", cell: (r) => tolerantCell(r, (s) => outOf(s.phase2Count, s.totalTasks, s.phase2Rate)) },
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
      `<p class="note">Tolerant never appears without strict beside it. It answers the weaker question — did the run compute the right numbers, whatever shape they came out in — and is not a substitute headline. <strong>Tolerant counts tasks passed and carries no reward</strong>: a tolerant replay yields a verdict per task, so there is nothing to average. Its counts and strict&#39;s reward are different units and are not a difference.</p>`
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
      // An unknown initial budget is a missing denominator, not a zero one: neither the total nor
      // the share it would divide into can be stated.
      const initial = b.initial === null ? UNKNOWN_BUDGET : esc(num(b.initial));
      const share = b.initial !== null && b.initial > 0 ? esc(percent(b.used / b.initial)) : DASH;
      return `<tr><th scope="row">${esc(r.provenance.run)}</th><td>${esc(num(b.used))}</td><td>${initial}</td><td>${share}</td><td>${esc(num(b.exhaustedTasks))}</td></tr>`;
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
          // `null` is the IR's own withholding, not a rendering decision taken here: a breakdown
          // average is a route back to the headline, so a withheld run carries none.
          const average = row.averageReward === null ? HELD : esc(scoreOf(row.averageReward));
          const passed = row.phase1Count === null ? HELD : esc(num(row.phase1Count));
          return `<td>${esc(num(row.tasks))}</td><td>${average}</td><td>${passed}</td>`;
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
// SQL formatting
// ---------------------------------------------------------------------------

/**
 * One token of a SQL statement, with the whitespace that preceded it.
 *
 * `gap` is whitespace-only by construction, and `formatSql` proves it by rebuilding its
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
 * Pretty-print a SQL statement someone else wrote.
 *
 * Written for Wren's plan, which arrives as one flat line — 778 characters in this run's shortest
 * case — so the page showed a horizontal scrollbar and no structure. This breaks before each major
 * clause keyword at the position it occurs and indents by parenthesis depth, so nested subqueries
 * are visible. It does not align, split expressions, or change any letter's case: a modest
 * formatter that is obviously right beats a clever one, because this is a record of what something
 * else produced.
 *
 * The invariant, and the reason reformatting the record is honest at all: the ONLY thing this
 * changes is whitespace BETWEEN tokens. Tokens are emitted verbatim in their original order, so
 * no character inside a literal or identifier can move. The statement is rebuilt from the lexer's
 * own pieces first, and anything that does not reconstruct byte-for-byte is returned untouched.
 *
 * **A statement that already has line breaks is returned untouched.** Not "breaks are preserved
 * and clause breaks added around them" — untouched, because the author already formatted it and
 * this function has no better information than they did. Keeping only the breaks was not enough:
 * the clause list has no notion of being inside a function call, so `WITHIN GROUP (ORDER BY x)`
 * and `FILTER (WHERE x > 0)` were split at their inner keyword, and the new line was re-indented
 * by PARENTHESIS DEPTH rather than by the author's own indentation. On the committed `alien-5`
 * report that rendered `PERCENTILE_CONT(0.5) WITHIN GROUP (` above `  ORDER BY SNQI) AS
 * median_snqi,` and `    JOIN Telescopes t` above `  ON s.TelescRef = …` — a continuation line
 * sitting SHALLOWER than the line it was split from, which a reader scans as a top-level clause.
 * 298 of this dataset's 300 gold statements were altered this way; gold arrives at a median of 30
 * lines, already laid out. Reflowing it also produced lines LONGER than the source — 548
 * characters against `alien_5`'s own longest of 82 — which is the opposite of the point.
 *
 * So the two inputs are told apart by the only signal that distinguishes them: Wren's plan is one
 * flat line and every break in it is this function's; gold carries the author's breaks and keeps
 * them, along with their indentation, their blank lines and their trailing spaces.
 *
 * Applied to `nativeSql` and to `goldSql` — the plan, and the benchmark's own answer. The
 * whitespace-only invariant is what makes it safe on gold: a reader comparing gold against a
 * submission is comparing the dataset's characters, not this function's opinion of them.
 *
 * **Never applied to `semanticSql`**: that is what the agent itself wrote, and reformatting it
 * would misrepresent the agent's output.
 */
export function formatSql(sql: string): string {
  const { tokens, trailing } = lexSql(sql);
  let rebuilt = "";
  for (const token of tokens) rebuilt += token.gap + token.text;
  if (rebuilt + trailing !== sql) return sql;
  // A break BETWEEN tokens is the author's layout; a newline in `trailing` is not, so a flat
  // statement that merely ends in a newline is still formatted.
  if (tokens.some((token) => token.gap.includes("\n"))) return sql;

  const lines: string[] = [];
  let line = "";
  let filled = false;
  let depth = 0;
  let i = 0;

  // Past the guard above, no token gap holds a newline: every break below is this function's.
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

/**
 * One row per task, with every verdict cell driven by the IR field rather than by a flag.
 *
 * `held` says only which of the two meanings a `null` `tolerantPassed` carries — withheld, or
 * never measured. Everything else is `null`-or-not: the failure class especially, which used to be
 * printed unconditionally and so published `passed (strict)` and `intent-miss` off runs whose
 * rewards the very same row was suppressing.
 */
/** The task's initial budget, or the word for the one no trace recorded. */
function budgetDenominator(task: TaskIR): string {
  return task.initialBudget === null ? UNKNOWN_BUDGET : esc(num(task.initialBudget));
}

/**
 * `intent-ungraded` reached through an undetermined knowledge channel, which `CLASS_LABEL` has no
 * sentence for.
 *
 * The class was introduced for one reason and now has two. Its own label — *no critical ambiguity
 * in the record was resolvable either way* — is the first. The second is a recovery the report
 * could not determine: `intent-ok` is a claim missed knowledge is allowed to overturn, so a report
 * that cannot say whether any was missed cannot make it, and a task lands here with a critical
 * ambiguity that WAS graded and found present. Printing the first sentence on that task states
 * something this page's own ambiguity column contradicts, so the second reason gets its own
 * sentence — which stays true where both reasons hold at once, and is the only one that is always
 * true here.
 */
const UNDETERMINED_RECOVERY_LABEL =
  "could not be graded — whether the required knowledge reached the agent was never determined";

/** The failure class as a sentence, the withholding that replaced it, or the reason above. */
function classCell(task: TaskIR): string {
  if (task.failureClass === null) return HELD;
  if (task.failureClass === "intent-ungraded" && task.knowledge.missed === null) {
    return esc(UNDETERMINED_RECOVERY_LABEL);
  }
  return esc(CLASS_LABEL[task.failureClass]);
}

function taskRow(task: TaskIR, held: boolean): string {
  const tolerant = held
    ? HELD
    : task.tolerantPassed === null
      ? `<span class="muted">not measured</span>`
      : passFail(task.tolerantPassed);
  return `<tr>
<th scope="row"><code>${esc(task.taskId)}</code></th>
<td>${esc(task.category)}</td>
<td>${esc(task.difficultyTier)}</td>
<td>${task.reward === null ? HELD : `<strong>${esc(scoreOf(task.reward))}</strong>`}</td>
<td>${task.phase1Passed === null ? HELD : passFail(task.phase1Passed)}</td>
<td>${task.phase2Passed === null ? HELD : passFail(task.phase2Passed)}</td>
<td>${tolerant}</td>
<td>${esc(num(task.budgetUsed))} / ${budgetDenominator(task)}</td>
<td>${classCell(task)}</td>
<td>${ambiguityCell(task.ambiguities)}</td>
</tr>`;
}

/**
 * The dataset's answer for this task.
 *
 * Rendered directly above the submissions so the comparison needs no scrolling and no memory: the
 * failure-class label says which KIND of miss it was, and only gold beside the submission shows
 * what the miss actually is.
 *
 * Passed through the same `formatSql` the planned statement goes through, and escaped like every
 * other interpolated value. For gold that is a no-op by construction: gold arrives with the
 * benchmark authors' own line breaks, and `formatSql` returns any already-broken statement
 * untouched rather than re-indenting it by parenthesis depth. See `formatSql`.
 */
function goldBlock(task: TaskIR): string {
  if (task.goldSql.length === 0) {
    // Not "gold is empty": no dataset row carried this task, which `buildRunReport` already names
    // as a defect. Saying it here too keeps a blank space from reading as an answer.
    return `<p class="muted">No dataset row carried this task, so its gold SQL is unknown.</p>`;
  }
  return statementBlocks(task.goldSql);
}

/** Gold statements, numbered when there is more than one, since `sol_sql` can carry several. */
function statementBlocks(statements: readonly string[]): string {
  const many = statements.length > 1;
  return statements
    .map((statement, index) => {
      const label = many
        ? `<p class="meta">Statement ${esc(num(index + 1))} of ${esc(num(statements.length))}</p>`
        : "";
      return `<div class="gold">${label}<pre class="sql">${esc(formatSql(statement))}</pre></div>`;
    })
    .join("");
}

/**
 * Phase 2's gold, under its own heading, or the statement that the dataset carried none.
 *
 * Phase 2 asks a follow-up question, and its answer is a different statement in a different field.
 * With only `sol_sql` on the page, a phase-2 submission sat under a heading that said "the answer"
 * beside gold that answers the first question — a correspondence the page implied and the dataset
 * does not have.
 */
function followUpGoldBlock(task: TaskIR): string {
  const note = `<p class="note">Phase 2 asks a <strong>different</strong> question, and the benchmark scores it against the dataset's <code>follow_up.sol_sql</code> — not against the phase-1 gold above. Also gated benchmark material.</p>`;
  if (task.followUpGoldSql.length === 0) {
    return `${note}<p class="muted">This task's dataset row carried no follow-up gold.</p>`;
  }
  return `${note}${statementBlocks(task.followUpGoldSql)}`;
}

/**
 * Which phase a submission answered, on the submission.
 *
 * A task that clears phase 1 submits again against a different question, and without this the two
 * sat in one undifferentiated list under one gold statement.
 */
function submitPhase(phase: number | null, withheld: boolean): string {
  if (phase !== null) return `phase ${esc(num(phase))}`;
  // The two reasons for `null` are not the same statement, and saying "unrecorded" on a withheld
  // run would blame the trace for something the report decided.
  return withheld
    ? `<span class="held">phase withheld</span>`
    : `<span class="muted">phase unrecorded</span>`;
}

/**
 * What the scorer said back, or the fact that it is not being said.
 *
 * `null` arrives only from a withheld run — the schema reserves it — and the note says which of the
 * two it is, because a submission block with nothing under the SQL reads as a submission that got
 * no reply rather than one whose reply is suppressed.
 */
function submitResult(result: string | null): string {
  return result === null
    ? `<p class="result"><span class="held">outcome withheld</span> — what the scorer said about this submission is a verdict, and this run publishes none.</p>`
    : `<p class="result">${esc(result)}</p>`;
}

/**
 * The knowledge record, and the one row of it that named an actor.
 *
 * `missed` is a fact a withheld run reports in full, like every other fact about what ran: the task
 * deleted the entry, `ask_user` was the only route back to it, and nothing usable came through. It
 * is not masked here, and could not be — masking is read off the IR, and this field is not `null`.
 * What "Never obtained" adds on top of the fact is an actor. Under a `void` simulator the route was
 * closed by the harness, so the page said the agent never obtained entry 0 beside a masked reward,
 * a masked phase verdict and a masked failure class — the suppressed `intent-miss` restated in the
 * one row suppression does not reach. So the sentence changes rather than the field.
 *
 * `recovered` keeps its own wording on every run: an empty list there names no failure and feeds no
 * class, and the asks are printed directly below it with their canned answers in full.
 */
function knowledgeRows(k: KnowledgeIR, withheld: boolean): string {
  const required = `<dt>Knowledge required</dt><dd>${numbers(k.required)}</dd>
<dt>Knowledge withheld by the task</dt><dd>${numbers(k.withheld)}</dd>
<dt>Recovered by asking</dt><dd>${knowledgeIds(k.recovered)}</dd>`;
  if (!withheld) return `${required}
<dt>Never obtained</dt><dd>${knowledgeIds(k.missed)}</dd>`;
  const named = k.missed !== null && k.missed.length > 0;
  const note = named
    ? ` <span class="muted">— the ask channel carried none of them, and this run publishes no verdict on the agent: this is not one.</span>`
    : "";
  return `${required}
<dt>Not delivered by the ask channel</dt><dd>${knowledgeIds(k.missed)}${note}</dd>`;
}

/**
 * The note that a recorded statement stops at the preview cut.
 *
 * `artifacts.ts` writes every trajectory string through `safeText`, which slices at
 * `PREVIEW_LIMIT`, and nothing downstream can tell a cut string from a short one by looking at it.
 * The ANALYSIS already treats it as a prefix: `gradeSubmitted` withdraws every `miss` graded
 * against such a record, because a fragment missing from a prefix may sit past the cut. The page
 * did not, so it printed the prefix under a heading that says this is what the agent submitted —
 * directly beneath the gold it is meant to be read against, where a reader takes the missing tail
 * for SQL the agent never wrote.
 */
function truncationNote(sql: string): string {
  if (!looksTruncated(sql)) return "";
  return `<p class="cut">Cut at the ${esc(num(PREVIEW_LIMIT))}-character recording limit — this is a prefix of the statement, not the whole of what ran.</p>`;
}

/** One attempt: what the agent wrote, what Wren planned, and what came back. */
function submitBlock(s: SubmitIR, withheld: boolean): string {
  const planned =
    s.nativeSql === null
      ? ""
      : `<p class="meta">Wren planned:</p><pre class="sql">${esc(
          formatSql(s.nativeSql),
        )}</pre>${truncationNote(s.nativeSql)}`;
  return `<div class="submit"><p class="meta">Attempt ${esc(num(s.attempt))} · ${submitPhase(
    s.phase,
    withheld,
  )} · cost ${esc(num(s.cost))} · budget ${esc(num(s.budgetBefore))} → ${esc(
    num(s.budgetAfter),
  )}</p><pre class="sql">${esc(s.semanticSql)}</pre>${truncationNote(
    s.semanticSql,
  )}${planned}${submitResult(s.result)}</div>`;
}

function taskDetail(task: TaskIR, withheld: boolean): string {
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
      : task.submits.map((s) => submitBlock(s, withheld)).join("");

  return `<details><summary><code>${esc(task.taskId)}</code> — ${esc(task.category)} · ${esc(
    task.difficultyTier,
  )}</summary>
<dl>
<dt>Database</dt><dd>${esc(task.database)}</dd>
<dt>High level</dt><dd>${task.highLevel ? "yes" : "no"}</dd>
<dt>Budget</dt><dd>${esc(num(task.budgetUsed))} used of ${budgetDenominator(task)}, ${esc(
    num(task.budgetRemaining),
  )} left</dd>
<dt>Model turns</dt><dd>${esc(num(task.modelTurns))}</dd>
<dt>Elapsed</dt><dd>${esc(num(task.elapsedSeconds))} s</dd>
<dt>Tool calls (charged)</dt><dd>${toolRow}</dd>
${knowledgeRows(task.knowledge, withheld)}
</dl>
<h5>Asks</h5>${asks}
<h5>Ground truth — phase 1</h5><p class="note">The dataset's own <code>sol_sql</code>, which is what phase 1 is scored against — gated benchmark material, on the page so a failure can be read against the answer rather than inferred from its label.</p>${goldBlock(task)}
<h5>Ground truth — phase 2 (follow-up)</h5>${followUpGoldBlock(task)}
<h5>Submissions</h5><p class="note">${
    withheld
      ? `Every attempt is here with the SQL it submitted, what it cost and the budget either side — all facts about what the agent did. What the scorer said back is <span class="held">withheld</span>, and so is the phase each attempt answered: labelling an attempt as the follow-up would say the scorer had accepted the one before it.`
      : `Each submission says which phase it answered. A phase-2 submission answers the follow-up question and is read against the follow-up gold, never against phase 1&#39;s.`
  }</p>${submits}
</details>`;
}

function tasksSection(reports: readonly RunReportIR[]): string {
  const head = `<tr><th scope="col">Task</th><th scope="col">Category</th><th scope="col">Difficulty</th><th scope="col">Reward</th><th scope="col">Phase 1</th><th scope="col">Phase 2</th><th scope="col">Tolerant</th><th scope="col">Budget</th><th scope="col">Why it landed there</th><th scope="col">Ambiguities</th></tr>`;

  const anyHeld = reports.some((r) => r.withheld !== null);
  const held = anyHeld
    ? `<p class="note">Cells marked <span class="held">withheld</span> are suppressed for the same reason the headline is: a run whose simulator was not answering produces per-task rewards no more trustworthy than their average, and a per-task verdict — including <em>why it landed there</em> — is a claim about the agent built out of the same untrustworthy run. Everything else about the task is unaffected and is reported.</p>`
    : "";

  const legend = `<p class="note">Ambiguity grades are computed against the <strong>last phase-1 submission</strong>, because the ambiguities the dataset records are phase 1&#39;s: a phase-2 submission answers a different question and would be graded against a snippet it has no reason to contain. <strong>exact</strong> — the gold fragment is present, modulo aliases, quoting and whitespace. <strong>columns</strong> — every column it references appears, written differently. <strong>miss</strong> — a column it needs never appears. <strong>inconclusive</strong> — the fragment references no qualified column, so it cannot be graded by columns and did not match literally; nearly half of this dataset&#39;s critical snippets are such fragments. It also covers a submission the recorder cut short at 2,000 characters: a fragment missing from a prefix may sit past the cut, so its absence evidences nothing about the agent. Only a critical <strong>miss</strong> is evidence of a misread question; <strong>inconclusive</strong> is evidence of nothing.</p>`;

  const blocks = perRun(reports, (r) => {
    if (r.tasks.length === 0) return `<p class="muted">No tasks.</p>`;
    const body = r.tasks.map((t) => taskRow(t, r.withheld !== null)).join("");
    const details = r.tasks.map((t) => taskDetail(t, r.withheld !== null)).join("");
    return `${tableOf(head, body)}<h4 class="detail-head">Trace</h4>${details}`;
  });

  return `<section id="tasks"><h2>Tasks</h2>
${held}
${legend}
${blocks}
</section>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * The gated-material notice, immediately under the title.
 *
 * This page carries the benchmark's ground-truth SQL, and it is a single self-contained file — the
 * kind of thing someone forwards without opening a task block first. So the statement goes where it
 * is read before anything is decided about the page, not inside the detail that carries the gold.
 *
 * Taken from the IR rather than from the constant it imports, for the same reason every other value
 * here is: the page states what the document states. `report.json` carries the identical sentence,
 * so the constraint survives the artifact being read by a machine instead of a person.
 */
function gatedNotice(reports: readonly RunReportIR[]): string {
  const first = reports[0];
  if (first === undefined) return "";
  return `<p class="gated"><strong>Gated benchmark material.</strong> ${esc(first.gatedNotice)}</p>`;
}

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
.gated{border:1px solid var(--bad);border-left:5px solid var(--bad);border-radius:.3rem;background:var(--panel);padding:.7rem .9rem;margin:0 0 1.8rem;font-size:.92rem}
.gated strong{color:var(--bad)}
.verdict{font-weight:600}
.verdict.healthy{color:var(--good)}
.verdict.degraded{color:var(--held)}
.verdict.void{color:var(--bad)}
.amb{display:inline-block;border:1px solid var(--line);border-radius:.5rem;padding:.05rem .4rem;margin:.1rem .15rem .1rem 0;font-size:.84rem}
.amb.miss{border-color:var(--bad)}
.amb.exact{border-color:var(--good)}
.amb.inconclusive{border-style:dashed;color:var(--muted)}
.amb-tag{color:var(--muted);margin-left:.35rem;font-size:.78rem}
details{border:1px solid var(--line);border-radius:.4rem;background:var(--panel);padding:.45rem .7rem;margin:.4rem 0}
summary{cursor:pointer;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem .8rem;margin:.6rem 0;font-size:.88rem}
dt{color:var(--muted)}
dd{margin:0}
pre{overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:.35rem;padding:.5rem .6rem;font-size:.82rem;margin:.35rem 0}
pre.sql{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.ask,.submit{border-left:3px solid var(--line);padding-left:.7rem;margin:.5rem 0}
.gold{border-left:3px solid var(--accent);padding-left:.7rem;margin:.5rem 0}
.gold .meta{color:var(--muted);font-size:.84rem;margin:.15rem 0}
.ask .q{font-weight:600;margin:.15rem 0}
.ask .a,.result{color:var(--muted);font-size:.88rem;margin:.15rem 0}
.canned{color:var(--bad);font-size:.85rem;margin:.15rem 0}
.cut{color:var(--held);font-size:.85rem;margin:.15rem 0}
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
    gatedNotice(reports),
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
