import { looksSqlTruncated } from "./preview-truncation.js";
import {
  classifyPhase,
  gradeAmbiguities,
  type AmbiguitySpec,
  type AmbiguityVerdict,
  type ClassifyInput,
  type FailureClass,
} from "./report-diagnose.js";
import { GATED_GROUND_TRUTH_NOTICE } from "./report-model.js";
import type {
  AskIR,
  GroupRowIR,
  KnowledgeIR,
  RunReportIR,
  ScoreIR,
  SubmitIR,
  TaskIR,
  TolerantScoreIR,
} from "./report-model.js";
import { assessSimulator, CANNED_USER_RESPONSE, type SimulatorHealth } from "./report-simulator.js";
import type { PrepareManifest } from "./runtime-layout.js";

/**
 * One finished run's parsed inputs, turned into the report IR.
 *
 * This module is pure by construction: no filesystem, no network, no clock, no environment. Every
 * number it reports comes from an input a caller already parsed, `generatedAt` included, so the
 * same inputs always produce the same document and a test can assert against it without a run.
 *
 * It is also deliberately unwilling to claim more than its inputs support:
 *
 * - **`knowledge.recovered` and `knowledge.missed` name an id only where the record can place it.**
 *   The ideal test is whether the withheld entry's NAME appears in a user answer, and the knowledge
 *   base text is not part of `RunInputs` — the offline report never reads the dataset's KB — so no
 *   answer can be tied to an id at all. What the record does settle is whether the recovery CHANNEL
 *   returned anything, and its two directions are not symmetric: `knowledgeFor` publishes the one
 *   that is a per-id fact and publishes `null` — the IR's word for undetermined, and not `[]` —
 *   for the one that is not. **The class that reads it honours all three states**: `null` is no
 *   evidence of a miss, and it is no evidence of the absence of one either, so it withdraws
 *   `intent-ok` as well as `intent-miss`; see `classifyWithRecovery`.
 * - **A cut record grades no `miss`.** `artifacts.ts` records at most `SQL_RECORD_LIMIT` characters of
 *   a submission, so one that reaches the limit is a prefix and a fragment missing from it may sit
 *   past the cut. `gradeSubmitted` withdraws every `miss` on such a record; grading it as one
 *   published the recording limit as a misread question.
 * - **`exec-error` is read from the message, not only from the marker.** `db_environment/server.py`
 *   prefixes an execution failure with `[exec_err_flg]`, but `tools.ts` strips that prefix from the
 *   observation it records in `tool_trajectory[].result` — so a marker-only predicate matches
 *   nothing this harness writes. `executionFailedResult` accepts both forms; see it for why.
 * - **A refused action is not a charged one.** `tools.ts` records an over-budget refusal as a
 *   trajectory entry of its own, as the official ledger does, and that entry carries the tool's
 *   list price beside a budget that never moved. `chargedEntry` is what tells the two apart, and
 *   counting a refused `ask_user` as an ask made the simulator answerable for a budget the AGENT
 *   spent.
 * - **An unanswered ask is not an answer.** An agent turn the simulator never replied to is
 *   evidence it did NOT answer, so it is kept out of the canned ratio and reported as a defect
 *   instead; see the `assessSimulator` call for what counting it would cost.
 * - **Health is graded on asks ATTEMPTED, which only this module can count.** A failed `ask_user`
 *   leaves a charged `tool_trajectory` entry and no dialogue turn at all, so the answers alone
 *   cannot tell a simulator that answered everything from one that was never reachable. See
 *   `askAttempts`.
 * - **A withheld run publishes no per-task verdict either.** The failure class, the reward, the
 *   phase outcomes and **each submission's `result` and `phase`** are computed for every task and
 *   then dropped from the published IR when the run is withheld, because a verdict derived from an
 *   untrustworthy run is untrustworthy too. Doing it in the renderer alone left `report.json`
 *   carrying every suppressed number — and the submission result carried it in the server's own
 *   words, `SQL failed Phase 1.` once per attempt, long after the reward cells were masked.
 * - A disagreement between the official row and Warble's own trace is a named **defect**, never
 *   silently reconciled: the two files disagreeing means one of them is lying about what ran. The
 *   check runs in both directions: a task the official file omits is named, not dropped. **A
 *   withheld run keeps every defect** — the anomaly is a statement about the record, and deleting
 *   it would hide the reason the run is untrustworthy — but the three that quote a reward or a
 *   phase verdict name the disagreement without either side of it; see `Defect`.
 *
 * Two things it does carry straight through are gated: `TaskIR.goldSql` is the dataset's own
 * `sol_sql` and `TaskIR.followUpGoldSql` is its `follow_up.sol_sql`, so every report this builds
 * also carries `GATED_GROUND_TRUTH_NOTICE` saying so.
 */

/**
 * The user-simulator model the official harness defaults to; anything else is a different
 * measurement.
 *
 * Read from the benchmark's own code — `BIRD-Interact-ADK/shared/config.py`'s `user_sim_model`
 * default — not from this repo's `.env.example`, which only suggests a model. The warning this
 * constant drives tells a reader "your simulator is not the one someone running the official
 * harness out of the box would get", so its reference point must be that default.
 * `tests/report-build.test.ts` pins it against the pinned checkout.
 *
 * A run that recorded no simulator model cannot be held against this constant at all. That case
 * warns too, and says so in those words — see `warningsFor`. Silence there would read as agreement.
 */
export const OFFICIAL_USER_SIM_MODEL = "anthropic/claude-haiku-4-5-20251001";

/**
 * How a submission result says the SQL never ran.
 *
 * `db_environment/server.py` emits exactly two execution failures, both prefixed `[exec_err_flg]`:
 * `"[exec_err_flg] Error executing submitted SQL: <error>"` and
 * `"[exec_err_flg] Submitted SQL execution timed out"`. **`tools.ts` strips `"[exec_err_flg] "`**
 * from the observation before recording it, deliberately — the agent should not see harness
 * plumbing — so the marker appears nowhere in a trace this harness writes, and the recorded result
 * begins with the bare message instead.
 *
 * Both forms are therefore matched, and neither is redundant: the official row may preserve the
 * marker where Warble's trace never does. Do not "simplify" this back to the marker alone; that is
 * the form that silently classified every failed execution as an intent problem.
 */
const EXEC_ERROR_MARKER = "[exec_err_flg]";
const EXEC_ERROR_MESSAGE = "Error executing submitted SQL:";
const EXEC_ERROR_TIMEOUT = "Submitted SQL execution timed out";

function executionFailedResult(result: string): boolean {
  const message = result.trimStart();
  return (
    message.includes(EXEC_ERROR_MARKER) ||
    message.startsWith(EXEC_ERROR_MESSAGE) ||
    message.startsWith(EXEC_ERROR_TIMEOUT)
  );
}

/** Stands in for a dataset field no dataset row supplied. */
const UNKNOWN = "unknown";

/** One turn of `dialogue_history`, from either the official row or the trace. */
export interface DialogueTurn {
  /** `"agent"` or `"user"`; kept as `string` because the reader must not crash on a third value. */
  readonly role: string;
  readonly content: string;
}

export interface OfficialMetrics {
  readonly total_tasks: number;
  readonly total_reward: number;
  readonly average_reward: number;
  readonly phase1_rate: number;
  readonly phase1_count: number;
  readonly phase2_rate: number;
  readonly phase2_count: number;
}

/** One row of the official runner's `a-interact.json`. */
export interface OfficialResultRow {
  readonly task_id: string;
  readonly instance_id: string;
  readonly database: string;
  readonly phase1_passed: boolean;
  readonly phase2_passed: boolean;
  readonly total_reward: number;
  readonly budget_used: number;
  readonly budget_remaining: number;
  readonly elapsed_seconds: number;
  readonly dialogue_history: readonly DialogueTurn[];
}

export interface OfficialResultFile {
  readonly metrics: OfficialMetrics;
  readonly results: readonly OfficialResultRow[];
}

/**
 * One entry of `trace.json`'s `tool_trajectory`: an action that ran, or one the budget refused.
 *
 * Not every entry is a charged call. `tools.ts` records an over-budget refusal here too, with the
 * tool's list price in `cost` and a budget that never moved — `chargedEntry` is what tells them
 * apart, and everything that counts calls has to go through it.
 */
export interface TrajectoryEntry {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly cost: number;
  readonly budget_before: number;
  readonly budget_after: number;
  /**
   * The a-interact phase the action belonged to; `artifacts.ts` records it on every entry.
   *
   * Optional because a trace written before it existed carries none, and `phaseOf` narrows rather
   * than trusts — `report-cli` casts each parsed `trace.json` to this type without validating it.
   */
  readonly phase?: unknown;
  /** What the agent wrote, before Wren planned it. */
  readonly semantic_sql?: string;
  /** What Wren planned; absent when the submission bypassed planning. */
  readonly native_sql?: string;
}

/** `traces/<task>/trace.json`, as `artifacts.ts` writes it. */
export interface WarbleTrace {
  readonly task_id: string;
  readonly initial_budget: number;
  readonly budget_remaining: number;
  readonly model_turns: number;
  readonly phase1_completed: boolean;
  readonly phase2_completed: boolean;
  readonly total_reward: number;
  readonly tool_trajectory: readonly TrajectoryEntry[];
}

/** `knowledge_ambiguity[]`: which `external_knowledge` entry the task hid from the agent's view. */
export interface KnowledgeAmbiguity {
  readonly deleted_knowledge?: unknown;
}

/** One row of `bird_interact_data_with_gt.jsonl`, narrowed to the fields the report reads. */
export interface DatasetRow {
  readonly instance_id: string;
  readonly selected_database: string;
  readonly category: string;
  readonly difficulty_tier: string;
  readonly high_level: boolean;
  /**
   * The task's ground-truth statements.
   *
   * `unknown[]` because `report-cli` casts each parsed JSONL line straight to this type without
   * validating it — `eval-data.ts` is what enforces `sol_sql: string[]` at preparation time — so
   * the reader here narrows rather than trusts, exactly as `external_knowledge` does.
   */
  readonly sol_sql?: readonly unknown[];
  /**
   * Phase 2's question and its own ground truth.
   *
   * `unknown` for the same reason `sol_sql` is: nothing validated this row. `follow_up.sol_sql` is
   * stored BOTH ways in the merged dataset — a bare string on 263 of its 300 rows and a list on the
   * other 37 — so `followUpGoldFor` accepts either, which is exactly what `goldSqlFor` must not do.
   */
  readonly follow_up?: { readonly sol_sql?: unknown };
  /** Ids into the database's knowledge base; non-integers are ignored rather than trusted. */
  readonly external_knowledge?: readonly unknown[];
  readonly knowledge_ambiguity?: readonly KnowledgeAmbiguity[];
  readonly user_query_ambiguity?: {
    readonly critical_ambiguity?: readonly AmbiguitySpec[];
    readonly non_critical_ambiguity?: readonly AmbiguitySpec[];
  };
}

/** `tolerant.json`: the autopsy's phase-1 verdict per task id. */
export type TolerantVerdicts = Readonly<Record<string, boolean>>;

export interface RunInputs {
  readonly run: string;
  readonly generatedAt: string;
  readonly manifest: PrepareManifest;
  readonly pythonVersion: string;
  readonly systemModel: string;
  /**
   * The model that drove the user simulator, **as the run recorded it**, or `null` when the run
   * recorded none. `null` means unknown, never "the official one": see `warningsFor`.
   */
  readonly userSimulatorModel: string | null;
  /** Parsed `a-interact.json`. */
  readonly official: OfficialResultFile;
  /** Parsed `traces/<task>/trace.json`, keyed by task id; a missing trace is a defect. */
  readonly traces: Readonly<Record<string, WarbleTrace>>;
  /** Parsed rows of `bird_interact_data_with_gt.jsonl`, keyed by `instance_id`. */
  readonly dataset: Readonly<Record<string, DatasetRow>>;
  /** Raw text of `logs/user-simulator.log`; empty string when absent. */
  readonly simulatorLog: string;
  /** Parsed `tolerant.json`, or `null` when no autopsy has run. */
  readonly tolerant: TolerantVerdicts | null;
}

/**
 * Pair each agent turn with the user turn that answered it.
 *
 * An agent turn with nothing after it yields `answer: ""` rather than being dropped: a question
 * the simulator never answered is exactly the evidence this report exists to surface.
 */
function dialogueAsks(
  history: readonly DialogueTurn[],
): { question: string; answer: string }[] {
  const asks: { question: string; answer: string }[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const turn = history[index];
    if (turn === undefined || turn.role !== "agent") continue;
    const reply = history[index + 1];
    asks.push({
      question: turn.content,
      answer: reply !== undefined && reply.role === "user" ? reply.content : "",
    });
  }
  return asks;
}

function askIrs(history: readonly DialogueTurn[]): AskIR[] {
  return dialogueAsks(history).map((ask) => ({
    question: ask.question,
    answer: ask.answer,
    canned: ask.answer.trim() === CANNED_USER_RESPONSE,
  }));
}

function integers(values: readonly unknown[]): number[] {
  return values.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
}

/**
 * The task's gold statements, or none.
 *
 * A row this run has no dataset entry for yields `[]` — the same defaulting every other dataset
 * field here does, and the missing row is already a named defect. Nothing is substituted for the
 * gold: a placeholder in a `<pre>` reads as a statement, and a reader would quote it.
 *
 * Anything that is not a list of statements — a bare string, a number, a missing field — yields no
 * gold rather than throwing, and blank statements are dropped rather than rendered as an empty
 * block. Preparation's schema already rejects all of it, so in practice none of this fires; it is
 * here because `report-cli` casts each parsed JSONL line to `DatasetRow` without validating it,
 * and one malformed row must not take down the whole report.
 *
 * This is gated benchmark material and it lands on the page — see `GATED_GROUND_TRUTH_NOTICE`.
 */
function goldSqlFor(row: DatasetRow | undefined): string[] {
  const statements = row?.sol_sql;
  if (!Array.isArray(statements)) return [];
  return statements.filter(
    (statement): statement is string => typeof statement === "string" && statement.trim() !== "",
  );
}

/**
 * Phase 2's gold, from `follow_up.sol_sql`.
 *
 * Phase 2 asks a DIFFERENT question and the benchmark scores it against a different answer, so a
 * page that showed only `sol_sql` beside submissions from both phases implied a correspondence
 * that is not there. This is the same gated material as `goldSql`, on the same page, under the
 * same notice.
 *
 * A bare string is accepted HERE and refused by `goldSqlFor`, and the difference is the dataset's,
 * not a looser standard: `sol_sql` is a list on all 300 rows, while `follow_up.sol_sql` is a bare
 * string on 263 of them and a list on the rest. Anything else — a number, a missing follow-up —
 * yields no gold rather than throwing.
 */
function followUpGoldFor(row: DatasetRow | undefined): string[] {
  const statements = row?.follow_up?.sol_sql;
  const list = Array.isArray(statements) ? statements : [statements];
  return list.filter(
    (statement): statement is string => typeof statement === "string" && statement.trim() !== "",
  );
}

/**
 * Which knowledge the task required, which of it was withheld, and which never arrived.
 *
 * **Neither verdict list may name an id the answers cannot place.** With no knowledge-base text in
 * the inputs there is nothing to match an answer against, and a task requires several entries while
 * withholding one of them — so an answer stating a formula is evidence for no one of those ids over
 * another. All the record settles is whether the recovery channel returned anything, and its three
 * cases are three different documents:
 *
 * - **The task withheld nothing.** There is no question to answer, so both lists are empty as a
 *   finding: nothing was recovered because nothing was hidden.
 * - **Nothing usable came back** — every ask canned or unanswered, or no ask made at all. The task
 *   deleted the entry from the knowledge base and `ask_user` is the only route back to it, so
 *   nothing reached the agent by any route and each withheld entry the task required is `missed`.
 *   That claim is exactly as strong as the evidence behind it, and `intent-miss` may rest on it.
 * - **Something usable came back.** WHICH entry it carried is unknown: an answer to an unrelated
 *   clarification is indistinguishable here from the withheld formula arriving. So the pair is
 *   `null`, which is the IR's word for undetermined — not `[]`, which would say this looked and
 *   found nothing either way. `recovered` naming every withheld id off one such answer was a per-id
 *   claim on channel-open evidence, and `missed` naming them feeds `intent-miss`, this report's
 *   strongest accusation, from the same evidence.
 *
 * Strengthening this means putting the knowledge base into `RunInputs` and matching each withheld
 * entry's own name against the answer text; that is a later change, and until it lands the open
 * channel settles nothing per id.
 */
function knowledgeFor(row: DatasetRow | undefined, asks: readonly AskIR[]): KnowledgeIR {
  const required = integers(row?.external_knowledge ?? []);
  const withheld = integers((row?.knowledge_ambiguity ?? []).map((a) => a.deleted_knowledge));
  if (withheld.length === 0) return { required, withheld, recovered: [], missed: [] };
  const answered = asks.some((ask) => !ask.canned && ask.answer.trim() !== "");
  if (answered) return { required, withheld, recovered: null, missed: null };
  return { required, withheld, recovered: [], missed: required.filter((id) => withheld.includes(id)) };
}

/**
 * The phase's class, reconciled with the fact that `missed` has three states and a count has two.
 *
 * `ClassifyInput.missedKnowledge` is a number, so `KnowledgeIR.missed` reaches `classifyPhase` as a
 * length and the undetermined case can only reach it as `0` — which is not "we could not tell" but
 * "the phase missed nothing", a determination `knowledgeFor` refuses to make. Zero costs nothing on
 * the way to `intent-miss`: that class needs a miss to EXIST, and an undetermined channel supplies
 * none, which is the reading the field's doc asks for. It costs the report its honesty on the way
 * to `intent-ok`.
 *
 * `classifyPhase` lets missed knowledge overturn a critical ambiguity graded present — an agent
 * cannot have applied a formula it never read — so `intent-ok` is reached only after that check has
 * run and cleared. On an undetermined channel it did not run: it was skipped for want of evidence,
 * and `intent-ok` is the strongest thing this report says in the agent's favour, the one class the
 * design requires evidence for rather than the absence of contrary evidence. Publishing it there
 * says the agent understood the question on the strength of a question this report declines to
 * answer. `intent-ungraded` is what the two of them come to: nothing in the record could grade it
 * either way.
 */
function classifyWithRecovery(
  input: ClassifyInput,
  missed: readonly number[] | null,
): FailureClass {
  const failureClass = classifyPhase(input);
  if (missed !== null || failureClass !== "intent-ok") return failureClass;
  return "intent-ungraded";
}

/** The trajectory entry's a-interact phase, or `null` when it recorded none it can be read as. */
function phaseOf(entry: TrajectoryEntry): number | null {
  const phase = entry.phase;
  return typeof phase === "number" && Number.isInteger(phase) && phase > 0 ? phase : null;
}

/** Every `submit_sql` of the task, numbered in the order it was charged. */
function submitsFor(trace: WarbleTrace | undefined): SubmitIR[] {
  const submits: SubmitIR[] = [];
  for (const entry of trace?.tool_trajectory ?? []) {
    if (entry.tool !== "submit_sql") continue;
    submits.push({
      attempt: submits.length + 1,
      phase: phaseOf(entry),
      cost: entry.cost,
      budgetBefore: entry.budget_before,
      budgetAfter: entry.budget_after,
      semanticSql: entry.semantic_sql ?? String(entry.args.sql ?? ""),
      nativeSql: entry.native_sql ?? null,
      result: entry.result,
    });
  }
  return submits;
}

/**
 * The submissions that answered phase 1's question, which are the only ones phase 1 can be graded
 * against.
 *
 * A task that clears phase 1 is asked a follow-up, so `submits.at(-1)` is the phase-2 answer for
 * every such task — and the phase-1 ambiguity snippets were being graded against it. On the
 * recorded `alien-5` run that put a `miss` on `alien_2`, a task the official scorer PASSED: the
 * fragment is in its phase-1 submission and absent from the follow-up, which answers a different
 * question and has no reason to contain it.
 *
 * A trace that recorded no phase at all is trusted for nothing but its order, and every submission
 * stays in scope — with no phases recorded there is no phase-2 submission to exclude, and dropping
 * them all would throw away the only evidence there is. Once ANY phase is recorded the record is
 * taken at its word.
 */
function phase1SubmitsOf(submits: readonly SubmitIR[]): SubmitIR[] {
  const recorded = submits.some((submit) => submit.phase !== null);
  return submits.filter((submit) => (recorded ? submit.phase === 1 : true));
}

/**
 * Grade the task's ambiguities against what the record KEPT of the submission.
 *
 * `artifacts.ts` writes every recorded string through `safeText`; statements are cut at the far
 * larger `SQL_RECORD_LIMIT`, so
 * a submission that reaches the limit is a PREFIX of what really ran. `miss` says a column the gold
 * fragment needs never appears — a claim about the whole submission, which a prefix cannot support
 * — and `classifyPhase` turns a critical `miss` into `intent-miss`, the strongest thing this report
 * says about an agent. An ambiguity the agent resolved past the cut was therefore published
 * as a misread question on the strength of where the recorder stopped writing.
 *
 * Only the negative grade is withdrawn, and `inconclusive` is where it goes: that grade already
 * means the snippet evidenced nothing about the agent, and `classifyPhase` counts it for neither
 * side. `exact` and `columns` are found IN the prefix, and text present in a prefix is present in
 * the whole, so the cut can only under-report them — withdrawing those as well would throw away the
 * evidence `intent-ok` is built from.
 */
function gradeSubmitted(
  submittedSql: string,
  critical: readonly AmbiguitySpec[],
  nonCritical: readonly AmbiguitySpec[],
): AmbiguityVerdict[] {
  const verdicts = gradeAmbiguities(submittedSql, critical, nonCritical);
  if (!looksSqlTruncated(submittedSql)) return verdicts;
  return verdicts.map(
    (verdict): AmbiguityVerdict =>
      verdict.match === "miss" ? { ...verdict, match: "inconclusive" } : verdict,
  );
}

/**
 * Whether the entry records an action that actually ran, rather than one the budget refused.
 *
 * `beginAction` refuses any tool but `submit_sql` whose cost the remaining budget will not cover,
 * and `tools.ts` writes that refusal into `tool_trajectory` — the official ADK ledger does the
 * same, so the trace has to. **The refusal entry carries the tool's LIST price in `cost`**, not
 * what was charged, so `cost` cannot tell the two apart; the budget can, and only the budget. Every
 * charged action subtracts a cost above zero, and the forced exit on a last `submit_sql` drops the
 * budget to `-1` from a budget that was never negative, so a charged entry always leaves the budget
 * lower than it found it. A refusal leaves it exactly where it was.
 *
 * A refused `ask_user` is the case this exists for. It produces no dialogue turn, so counting it as
 * a charged call turned it into an ask the simulator appears to have left unanswered — which drives
 * `assessSimulator` toward `void` and withholds every score in the report, over a budget the AGENT
 * spent. `submit_sql` is exempt from refusal upstream, which is why `submitsFor` needs no filter of
 * its own: dropping a submission on a budget heuristic would delete the record of what the agent
 * actually submitted.
 *
 * An entry that recorded no budget at all counts as charged, deliberately. `report-cli` casts each
 * parsed `trace.json` to `TrajectoryEntry` without validating it, so two absent fields would
 * otherwise compare equal, read as one long refusal, and zero every count in the report at once.
 */
function chargedEntry(entry: TrajectoryEntry): boolean {
  if (!Number.isFinite(entry.budget_before) || !Number.isFinite(entry.budget_after)) return true;
  return entry.budget_before !== entry.budget_after;
}

/** How many CHARGED calls the task made per tool; a refused action is not one. */
function toolCallsFor(trace: WarbleTrace | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of trace?.tool_trajectory ?? []) {
    if (!chargedEntry(entry)) continue;
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1;
  }
  return counts;
}

/**
 * Where the official record and Warble's own trace disagree about what ran.
 *
 * Named, never reconciled: identity, reward and phase outcomes are the three things both files
 * claim independently, so a difference means one of them is wrong and the reader must know which
 * numbers are in question.
 */
/**
 * A defect in both of the wordings a report can publish it in.
 *
 * A defect is a statement about the RECORD, not about the agent, so a withheld run keeps every one
 * of them: the disagreement between the official file and Warble's trace is precisely the anomaly a
 * reader of a withheld report needs, and blanket-masking would delete it. What a withheld run drops
 * is only the VALUES a disagreement quotes — three of these templates name a reward or a phase
 * verdict on both sides, which is the withheld score handed straight back.
 *
 * The masked wording still names the fields and still says they disagree. That is not a leak: two
 * booleans differing tells you nothing about which one said `passed`.
 *
 * Built as a pair rather than chosen at the point of writing because the withholding decision is
 * not known yet — it depends on a simulator verdict assessed from the finished task list — exactly
 * as `ScoredTask` carries real verdicts that `withoutVerdicts` drops later.
 */
interface Defect {
  /** The line as stated when the run's scores are reportable. */
  readonly full: string;
  /** The same anomaly with every verdict value removed, for a withheld run. */
  readonly masked: string;
}

/** A defect that quotes no verdict, and so reads the same either way. */
function plainDefect(text: string): Defect {
  return { full: text, masked: text };
}

/** A defect whose two sides are verdicts: named on any run, quoted only on a reportable one. */
function phaseDisagreement(
  id: string,
  officialField: string,
  officialValue: boolean,
  traceField: string,
  traceValue: boolean,
): Defect {
  return {
    full: `${id}: official ${officialField} ${officialValue} but trace ${traceField} ${traceValue}`,
    masked: `${id}: official ${officialField} and trace ${traceField} disagree; both values are withheld`,
  };
}

function defectsFor(row: OfficialResultRow, trace: WarbleTrace | undefined): Defect[] {
  const id = row.task_id;
  if (trace === undefined) return [plainDefect(`${id}: no Warble trace for this task`)];
  const defects: Defect[] = [];
  if (trace.task_id !== id) {
    defects.push(plainDefect(`${id}: trace records task_id ${trace.task_id}`));
  }
  if (trace.total_reward !== row.total_reward) {
    defects.push({
      full: `${id}: official reward ${row.total_reward} but trace reward ${trace.total_reward}`,
      masked: `${id}: the official reward and the trace reward disagree; both values are withheld`,
    });
  }
  if (trace.phase1_completed !== row.phase1_passed) {
    defects.push(
      phaseDisagreement(id, "phase1_passed", row.phase1_passed, "phase1_completed", trace.phase1_completed),
    );
  }
  if (trace.phase2_completed !== row.phase2_passed) {
    defects.push(
      phaseDisagreement(id, "phase2_passed", row.phase2_passed, "phase2_completed", trace.phase2_completed),
    );
  }
  return defects;
}

/**
 * A task with every verdict still on it, before the withholding decision.
 *
 * `TaskIR` types those four fields `| null` because a withheld run publishes none of them; scoring
 * and grouping run over this narrower shape instead, so the aggregate is computed from real
 * numbers exactly once and the masking is a single later step rather than a condition threaded
 * through every reader.
 */
interface ScoredTask extends TaskIR {
  readonly reward: number;
  readonly phase1Passed: boolean;
  readonly phase2Passed: boolean;
  readonly failureClass: FailureClass;
}

function buildTask(
  row: OfficialResultRow,
  trace: WarbleTrace | undefined,
  datasetRow: DatasetRow | undefined,
  tolerant: TolerantVerdicts | null,
): ScoredTask {
  const asks = askIrs(row.dialogue_history);
  const submits = submitsFor(trace);
  // Snippets are graded against the last submission OF PHASE 1: earlier attempts are drafts, and a
  // phase-2 attempt answers a different question — see `phase1SubmitsOf`.
  const phase1Submits = phase1SubmitsOf(submits);
  const lastSubmit = phase1Submits.at(-1);
  const ambiguity = datasetRow?.user_query_ambiguity;
  const ambiguities = gradeSubmitted(
    lastSubmit?.semanticSql ?? "",
    ambiguity?.critical_ambiguity ?? [],
    ambiguity?.non_critical_ambiguity ?? [],
  );
  const knowledge = knowledgeFor(datasetRow, asks);
  // A task absent from `tolerant.json` was not judged; that is not the same as judged failing.
  const tolerantPassed = tolerant === null ? null : (tolerant[row.task_id] ?? null);
  const phase1Passed = row.phase1_passed;
  return {
    taskId: row.task_id,
    database: datasetRow?.selected_database ?? row.database,
    category: datasetRow?.category ?? UNKNOWN,
    difficultyTier: datasetRow?.difficulty_tier ?? UNKNOWN,
    highLevel: datasetRow?.high_level ?? false,
    reward: row.total_reward,
    phase1Passed,
    phase2Passed: row.phase2_passed,
    tolerantPassed,
    budgetUsed: row.budget_used,
    budgetRemaining: row.budget_remaining,
    // With no trace there is no initial budget to report. `0` was not a safe default: it rendered
    // `18 / 0`, a task that used more than all of a budget it never had. The missing trace is
    // already a named defect, and `null` says the denominator is unknown.
    initialBudget: trace?.initial_budget ?? null,
    modelTurns: trace?.model_turns ?? 0,
    elapsedSeconds: row.elapsed_seconds,
    toolCalls: toolCallsFor(trace),
    goldSql: goldSqlFor(datasetRow),
    followUpGoldSql: followUpGoldFor(datasetRow),
    submits,
    asks,
    knowledge,
    ambiguities,
    failureClass: classifyWithRecovery(
      {
        passed: phase1Passed,
        tolerantPassed,
        executionFailed: executionFailedResult(lastSubmit?.result ?? ""),
        // Told apart deliberately: with no trace, `submitted` would be false because the file that
        // records submissions is absent, not because nothing was submitted.
        recordMissing: trace === undefined,
        submitted: phase1Submits.length > 0,
        ambiguities,
        // `null` is no evidence of a miss, never zero misses and never every withheld entry: see
        // `KnowledgeIR.missed` for why an undetermined channel cannot support an `intent-miss`.
        missedKnowledge: knowledge.missed?.length ?? 0,
      },
      // The same `null`, which the count above cannot carry and `intent-ok` may not ignore.
      knowledge.missed,
    ),
  };
}

function sum(tasks: readonly ScoredTask[], valueOf: (task: ScoredTask) => number): number {
  return tasks.reduce((total, task) => total + valueOf(task), 0);
}

/**
 * A share of the run's tasks, or `null` when there were none.
 *
 * `0` for an undefined quotient is the substitution this exists to refuse. A run that scored no
 * tasks used to publish "average reward 0.00" and "phase 1 passed 0/0 (0%)" — three findings about
 * an agent, computed from an empty list and schema-valid. There is no rate over zero tasks, and
 * `null` is how the IR says so; `emptyRunDefects` names the empty run besides.
 */
function rateOver(totalTasks: number): (count: number) => number | null {
  return (count) => (totalTasks === 0 ? null : count / totalTasks);
}

/**
 * The strict column: the official scorer's verdict, and the only column carrying a reward.
 *
 * Phase 2 is the official verdict here and in tolerant alike — nothing re-judges it, and a phase-2
 * pass is only reachable through a strict phase-1 pass, so it is a floor under either reading.
 */
function strictScore(tasks: readonly ScoredTask[]): ScoreIR {
  const totalTasks = tasks.length;
  const totalReward = sum(tasks, (task) => task.reward);
  const phase1Count = tasks.filter((task) => task.phase1Passed).length;
  const phase2Count = tasks.filter((task) => task.phase2Passed).length;
  const rate = rateOver(totalTasks);
  return {
    totalTasks,
    totalReward,
    averageReward: rate(totalReward),
    phase1Count,
    phase1Rate: rate(phase1Count),
    phase2Count,
    phase2Rate: rate(phase2Count),
  };
}

/**
 * The tolerant column: how many TASKS passed, and nothing that could be read as a reward.
 *
 * A tolerant replay yields a verdict per task, so there is no per-task score to sum or average.
 * The column that used to carry `averageReward` here was `phase1Rate` by construction, printed one
 * line under strict's genuine reward average — two different units read as one number improving.
 */
function tolerantScore(
  tasks: readonly ScoredTask[],
  passed: (task: ScoredTask) => boolean,
): TolerantScoreIR {
  const totalTasks = tasks.length;
  const phase1Count = tasks.filter(passed).length;
  const phase2Count = tasks.filter((task) => task.phase2Passed).length;
  const rate = rateOver(totalTasks);
  return {
    totalTasks,
    phase1Count,
    phase1Rate: rate(phase1Count),
    phase2Count,
    phase2Rate: rate(phase2Count),
  };
}

function groupBy(tasks: readonly ScoredTask[], keyOf: (task: ScoredTask) => string): GroupRowIR[] {
  const groups = new Map<string, ScoredTask[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [task]);
    else bucket.push(task);
  }
  return [...groups]
    .map(([key, members]) => ({
      key,
      tasks: members.length,
      averageReward: sum(members, (task) => task.reward) / members.length,
      phase1Count: members.filter((task) => task.phase1Passed).length,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Everything a reader must know before quoting a number off this page. */
function warningsFor(
  inputs: RunInputs,
  tasks: readonly ScoredTask[],
  simulator: SimulatorHealth,
): string[] {
  const warnings = [
    "This run scores a subset of one database's tasks: it is not a BIRD-Interact score and is " +
      "never comparable with the official leaderboard.",
    "Results from WrenAI's legacy local harness use different action, context and scoring " +
      "boundaries; they are not comparable with this run in either direction.",
  ];
  // Three states, not two. A recorded model either matches the official default or it does not,
  // and an unrecorded one matches nothing — it cannot be compared at all. Saying nothing in that
  // third case would leave the loudest signal (no warning) meaning both "verified official" and
  // "we have no idea", which is the misattribution this section exists to prevent.
  // `unexercised` publishes its scores, so the caveat has to travel with them rather than being
  // left to whoever reads the verdict word. A machine gate reads this array; it does not read CSS.
  if (simulator.verdict === "unexercised") {
    warnings.push(
      "This run never called ask_user, so the user simulator was never exercised and its health " +
        "is unknown rather than good. The benchmark deletes one required knowledge entry per task " +
        "and asking is the only route back to it, so these scores measure a strategy that " +
        "declined that route.",
    );
  }
  const simulatorModel = inputs.userSimulatorModel;
  if (simulatorModel === null) {
    warnings.push(
      "This run did not record which model drove the user simulator, so it cannot be compared " +
        `against the official ${OFFICIAL_USER_SIM_MODEL}: the simulator is unrecorded, not known ` +
        "to match. The simulator's behaviour is part of the measurement.",
    );
  } else if (simulatorModel !== OFFICIAL_USER_SIM_MODEL) {
    warnings.push(
      `The user simulator ran on ${simulatorModel}, not the official ` +
        `${OFFICIAL_USER_SIM_MODEL}; the simulator's behaviour is part of the measurement.`,
    );
  }
  if (!tasks.some((task) => task.category === "Management")) {
    warnings.push(
      "No Management task ran: the full a-interact protocol is only exercised when both Query " +
        "and Management tasks are present.",
    );
  }
  warnings.push(
    `${tasks.length} task${tasks.length === 1 ? "" : "s"} scored; a subset this size moves by ` +
      "whole tasks, so read the per-task detail rather than the rate.",
  );
  return warnings;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Why a void run's scores are withheld, in the run's own numbers. */
function withheldReason(simulator: SimulatorHealth): string {
  const evidence: string[] = [];
  if (simulator.llmCallFailures > 0) {
    evidence.push(`${plural(simulator.llmCallFailures, "LLM call failure")} in its log`);
  }
  const { asks, answered, cannedResponses } = simulator;
  // The three ways a run gets no real answer are told apart, because "canned" and "never came
  // back" point at different halves of the simulator and the reader is the one who has to fix it.
  if (asks > 0 && answered === cannedResponses) {
    const unanswered = asks - answered;
    if (cannedResponses === asks) {
      evidence.push(`all ${plural(asks, "ask")} answered with the canned non-answer`);
    } else if (answered === 0) {
      evidence.push(`none of the ${plural(asks, "ask")} it was sent came back with any answer`);
    } else {
      evidence.push(
        `no real answer to any of the ${plural(asks, "ask")} it was sent ` +
          `(${cannedResponses} canned, ${unanswered} unanswered)`,
      );
    }
  }
  const detail = evidence.length === 0 ? "it answered nothing usable" : evidence.join("; ");
  return (
    `Scores withheld: the user simulator was void (${detail}). ` +
    "A broken simulator is indistinguishable from a weak agent, so no score from this run means " +
    "anything."
  );
}

/**
 * The other direction of the cross-check.
 *
 * `buildRunReport` scores what the official file contains, so a task that ran — it has a trace, or
 * the manifest lists it — but never reached `a-interact.json` would otherwise vanish from the
 * report entirely. One-directional agreement is not agreement. Such a task contributes no `TaskIR`
 * (nothing can score what the official record does not contain) but its absence is stated.
 */
/**
 * Defects about the run as a whole rather than about one task.
 *
 * A run with no tasks is one of them. It is not a report of a run that scored badly; it is a report
 * with no measurement in it, and it used to render as `healthy`, `average reward 0.00`,
 * `phase 1 passed 0/0 (0%)` and no defects at all. The rates are `null` now, but a page can still
 * be read past a dash — so the fact that such a report was producible is said out loud, in the
 * section a reader is told not to quote a number past.
 */
function emptyRunDefects(tasks: readonly ScoredTask[]): string[] {
  if (tasks.length > 0) return [];
  return [
    "this run scored no tasks: the report has no average, no rate and nothing to compare, and " +
      "should not have been produced for an empty run",
  ];
}

function absentFromOfficialDefects(inputs: RunInputs, scored: ReadonlySet<string>): string[] {
  const defects: string[] = [];
  // Sorted: a `Record`'s key order is the caller's parse order, and defects must not reshuffle.
  for (const id of Object.keys(inputs.traces).sort()) {
    if (!scored.has(id)) {
      defects.push(`${id}: a Warble trace exists but the official result file has no row for it`);
    }
  }
  for (const id of inputs.manifest.taskIds) {
    if (!scored.has(id)) {
      defects.push(`${id}: the manifest lists this task but the official result file has no row for it`);
    }
  }
  return defects;
}

/** The tool whose charged calls are the run's asks, whether or not an answer came back. */
const ASK_TOOL = "ask_user";

/**
 * How many asks a task ATTEMPTED.
 *
 * `toolCalls.ask_user` counts the charged calls, the ones that errored included and the ones the
 * budget refused excluded: `tools.ts` records the trajectory entry after the try/catch and the
 * dialogue pair only inside the successful path, so a transport error or an HTTP 500 leaves the
 * call recorded and no dialogue turn — while a refusal leaves an entry for an ask that never
 * reached the simulator at all, which is `chargedEntry`'s job to drop. The dialogue's
 * own agent turns are counted too and the larger wins — a recorded answer is itself evidence of an
 * ask, and a trace with fewer calls than the dialogue has turns is a defect the caller already
 * names rather than a reason to undercount.
 */
function askAttempts(task: TaskIR): number {
  return Math.max(task.toolCalls[ASK_TOOL] ?? 0, task.asks.length);
}

/**
 * One line per task that attempted more asks than it got answers for, or `null` when none did.
 *
 * Both shapes of the anomaly land here: an agent turn the simulator replied to with nothing, and a
 * charged `ask_user` that never produced a turn at all. The aggregate verdict already accounts for
 * them; this names the task, so a reader can see WHICH task went unanswered.
 */
function unansweredAskDefect(task: TaskIR): string | null {
  const attempted = askAttempts(task);
  const answered = task.asks.filter((ask) => ask.answer.trim() !== "").length;
  const unanswered = attempted - answered;
  if (unanswered <= 0) return null;
  return (
    `${task.taskId}: ${plural(unanswered, "attempted ask")} received no answer ` +
    `(${attempted} attempted, ${answered} answered)`
  );
}

/**
 * Every per-task verdict dropped, for a run whose scores are withheld.
 *
 * What survives is everything that is not a score: which tasks ran, what they asked, what they
 * submitted, how many times, what budget they burned, what the dataset said was ambiguous. Those
 * remain true when the reward does not. The verdicts go because a failure class derived from an
 * untrustworthy run is itself untrustworthy — the recorded VOID run published `intent-miss` five
 * times beside 47 withheld cells, pinning on the agent a failure its own page said meant nothing.
 *
 * **The submission is part of that, and it took two fields.** `result` is the benchmark server's
 * own reply, so a withheld report published `SQL failed Phase 1.` sixteen times over — from which
 * "0 of 5 tasks passed phase 1" reads straight off, the exact figure every masked cell on the page
 * existed to suppress, and on a run with a passing task it would have printed `Reward: 0.7`
 * verbatim. `phase` is the same leak in a number: a submission labelled `phase 2` says the scorer
 * accepted the phase-1 attempt before it, which is `phase1Passed` — `null` two lines up — restored.
 *
 * **And it took the class's two INPUTS with it, or suppressing the class bought nothing.**
 * `classifyPhase` reaches `intent-miss` from exactly two things: a critical ambiguity graded `miss`,
 * and a required knowledge entry counted `missed`. Both used to survive `withoutVerdicts` and both
 * used to render, so the suppressed class was one line of arithmetic away for any reader and
 * straightforwardly present for the CI gate reading `report.json` — and the same grades
 * restore `intent-ok` and `intent-ungraded` just as easily. A grade is itself a verdict on the
 * agent: it is the agent's SQL compared against gold. So the ambiguities keep their term, type,
 * criticality and mask flag — all dataset facts about the QUESTION — and lose `match`; the
 * knowledge record keeps `required` and `withheld` for the same reason and loses `recovered` and
 * `missed`.
 *
 * What is deliberately KEPT is everything about what the agent did: the attempt number (a reader
 * still sees a task submitted three times), both SQL statements, the cost and the budget either
 * side, the asks and their answers. None of those is a verdict, and the run genuinely carries them.
 */
function withoutVerdicts(task: ScoredTask): TaskIR {
  return {
    ...task,
    reward: null,
    phase1Passed: null,
    phase2Passed: null,
    tolerantPassed: null,
    failureClass: null,
    ambiguities: task.ambiguities.map((verdict) => ({ ...verdict, match: null })),
    knowledge: { ...task.knowledge, recovered: null, missed: null },
    submits: task.submits.map((submit) => ({ ...submit, phase: null, result: null })),
  };
}

/** The same, for a breakdown row: the census stands, the group's score does not. */
function withoutGroupScores(row: GroupRowIR): GroupRowIR {
  return { ...row, averageReward: null, phase1Count: null };
}

export function buildRunReport(inputs: RunInputs): RunReportIR {
  const defects: Defect[] = [];
  const tasks: ScoredTask[] = [];
  const scored = new Set(inputs.official.results.map((row) => row.task_id));
  for (const row of inputs.official.results) {
    const trace = inputs.traces[row.task_id];
    const datasetRow = inputs.dataset[row.instance_id];
    defects.push(...defectsFor(row, trace));
    if (datasetRow === undefined) {
      defects.push(plainDefect(`${row.task_id}: no dataset row for instance ${row.instance_id}`));
    }
    const task = buildTask(row, trace, datasetRow, inputs.tolerant);
    const unanswered = unansweredAskDefect(task);
    if (unanswered !== null) defects.push(plainDefect(unanswered));
    tasks.push(task);
  }
  defects.push(...absentFromOfficialDefects(inputs, scored).map(plainDefect));
  defects.push(...emptyRunDefects(tasks).map(plainDefect));

  // Attempts and answers are counted separately and both are needed. Empty answers are filtered
  // OUT of the answer list — an empty answer is an agent turn the simulator never answered,
  // evidence it did not answer — while the ask it answered nothing to still counts as an attempt.
  // Counting only answers is what let a run whose every `ask_user` errored read as `healthy`: with
  // no dialogue turn written for a failed ask, it had answered all zero of its asks.
  const simulator = assessSimulator({
    log: inputs.simulatorLog,
    attempts: tasks.reduce((total, task) => total + askAttempts(task), 0),
    answers: tasks.flatMap((task) =>
      task.asks.map((ask) => ask.answer).filter((answer) => answer.trim() !== ""),
    ),
  });
  const withheld = simulator.verdict === "void" ? withheldReason(simulator) : null;
  const strict = withheld === null ? strictScore(tasks) : null;
  // A strict pass IS a tolerant pass. The official scorer can accept a submission through the
  // dataset's own `test_cases`, which may accept a form our result-set replay does not reproduce
  // — `alien_2` of the recorded alien-5 run passes strict on `STDDEV` where the replay wants
  // `STDDEV_POP`. Tolerant asks the strictly weaker question (right numbers, ignoring shape), so
  // it can never count fewer tasks than strict; without this the pair renders inverted, as if
  // tolerant were the harder bar, which is the opposite of what it measures.
  const tolerantPass = (task: ScoredTask): boolean =>
    task.phase1Passed || task.tolerantPassed === true;
  const tolerant =
    withheld === null && inputs.tolerant !== null ? tolerantScore(tasks, tolerantPass) : null;
  // Scored above, published here: the aggregate is computed from the real numbers and then the
  // numbers themselves are withheld, so no reader recovers the headline from a breakdown or a row.
  const publishedTasks: readonly TaskIR[] = withheld === null ? tasks : tasks.map(withoutVerdicts);
  const publishGroups = (rows: readonly GroupRowIR[]): GroupRowIR[] =>
    withheld === null ? [...rows] : rows.map(withoutGroupScores);

  return {
    version: 1,
    generatedAt: inputs.generatedAt,
    gatedNotice: GATED_GROUND_TRUTH_NOTICE,
    provenance: {
      run: inputs.run,
      officialCommit: inputs.manifest.official.commit,
      publicSnapshotCommit: inputs.manifest.publicSnapshot.commit,
      imageId: inputs.manifest.database.imageId,
      repoDigests: inputs.manifest.database.repoDigests,
      wrenVersion: inputs.manifest.wren.version,
      pythonVersion: inputs.pythonVersion,
      taskIds: inputs.manifest.taskIds,
      systemModel: inputs.systemModel,
      userSimulatorModel: inputs.userSimulatorModel,
    },
    simulator,
    warnings: warningsFor(inputs, tasks, simulator),
    // Every defect survives a withheld run; the ones that quote a verdict lose the values. See
    // `Defect` for why deleting the anomaly would be the worse of the two failures.
    defects: defects.map((defect) => (withheld === null ? defect.full : defect.masked)),
    strict,
    tolerant,
    withheld,
    budget: {
      used: sum(tasks, (task) => task.budgetUsed),
      // One unknown term makes the whole sum unknown. A total that quietly dropped a task's budget
      // would still be printed as the run's, and divided into to produce a share of a total that
      // is not the total — a bigger overstatement than the missing term.
      initial: tasks.some((task) => task.initialBudget === null)
        ? null
        : sum(tasks, (task) => task.initialBudget ?? 0),
      exhaustedTasks: tasks.filter((task) => task.budgetRemaining <= 0).length,
    },
    byDifficulty: publishGroups(groupBy(tasks, (task) => task.difficultyTier)),
    byHighLevel: publishGroups(groupBy(tasks, (task) => String(task.highLevel))),
    difficultyVocabularies: [...new Set(tasks.map((task) => task.difficultyTier))].sort(),
    tasks: publishedTasks,
  };
}
