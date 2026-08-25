import {
  classifyPhase,
  gradeAmbiguities,
  type AmbiguitySpec,
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
 * - **`knowledge.recovered` is weaker than it looks.** The ideal test is whether the withheld
 *   entry's NAME appears in a user answer, but the knowledge base text is not part of
 *   `RunInputs` — the offline report never reads the dataset's KB. So a withheld id is marked
 *   `recovered` when the task got at least one ask answer that is non-empty and not the canned
 *   non-answer, and `missed` otherwise. That is evidence the recovery CHANNEL was open, not
 *   evidence the definition came through it. Strengthening it means adding the KB to `RunInputs`,
 *   which is a later change; until then the report must not be read as proving recovery.
 * - **`exec-error` is read from the message, not only from the marker.** `db_environment/server.py`
 *   prefixes an execution failure with `[exec_err_flg]`, but `tools.ts` strips that prefix from the
 *   observation it records in `tool_trajectory[].result` — so a marker-only predicate matches
 *   nothing this harness writes. `executionFailedResult` accepts both forms; see it for why.
 * - **An unanswered ask is not an answer.** An agent turn the simulator never replied to is
 *   evidence it did NOT answer, so it is kept out of the canned ratio and reported as a defect
 *   instead; see the `assessSimulator` call for what counting it would cost.
 * - **Health is graded on asks ATTEMPTED, which only this module can count.** A failed `ask_user`
 *   leaves a charged `tool_trajectory` entry and no dialogue turn at all, so the answers alone
 *   cannot tell a simulator that answered everything from one that was never reachable. See
 *   `askAttempts`.
 * - **A withheld run publishes no per-task verdict either.** The failure class, the reward and the
 *   phase outcomes are computed for every task and then dropped from the published IR when the run
 *   is withheld, because a verdict derived from an untrustworthy run is untrustworthy too. Doing
 *   it in the renderer alone left `report.json` carrying every suppressed number.
 * - A disagreement between the official row and Warble's own trace is a named **defect**, never
 *   silently reconciled: the two files disagreeing means one of them is lying about what ran. The
 *   check runs in both directions: a task the official file omits is named, not dropped.
 *
 * One thing it does carry straight through is gated: `TaskIR.goldSql` is the dataset's own
 * `sol_sql`, so every report this builds also carries `GATED_GROUND_TRUTH_NOTICE` saying so.
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

/** One charged action in `trace.json`'s `tool_trajectory`. */
export interface TrajectoryEntry {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly cost: number;
  readonly budget_before: number;
  readonly budget_after: number;
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
 * Which knowledge the task required, which of it was withheld, and which never arrived.
 *
 * `recovered` is the weak half, and the module doc says why: with no knowledge-base text in the
 * inputs, an open recovery channel is all this can honestly assert.
 */
function knowledgeFor(row: DatasetRow | undefined, asks: readonly AskIR[]): KnowledgeIR {
  const required = integers(row?.external_knowledge ?? []);
  const withheld = integers((row?.knowledge_ambiguity ?? []).map((a) => a.deleted_knowledge));
  const answered = asks.some((ask) => !ask.canned && ask.answer.trim() !== "");
  const recovered = answered ? [...withheld] : [];
  const missed = required.filter((id) => withheld.includes(id) && !recovered.includes(id));
  return { required, withheld, recovered, missed };
}

/** Every `submit_sql` of the task, numbered in the order it was charged. */
function submitsFor(trace: WarbleTrace | undefined): SubmitIR[] {
  const submits: SubmitIR[] = [];
  for (const entry of trace?.tool_trajectory ?? []) {
    if (entry.tool !== "submit_sql") continue;
    submits.push({
      attempt: submits.length + 1,
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

function toolCallsFor(trace: WarbleTrace | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of trace?.tool_trajectory ?? []) {
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
function defectsFor(row: OfficialResultRow, trace: WarbleTrace | undefined): string[] {
  const id = row.task_id;
  if (trace === undefined) return [`${id}: no Warble trace for this task`];
  const defects: string[] = [];
  if (trace.task_id !== id) {
    defects.push(`${id}: trace records task_id ${trace.task_id}`);
  }
  if (trace.total_reward !== row.total_reward) {
    defects.push(`${id}: official reward ${row.total_reward} but trace reward ${trace.total_reward}`);
  }
  if (trace.phase1_completed !== row.phase1_passed) {
    defects.push(
      `${id}: official phase1_passed ${row.phase1_passed} but trace phase1_completed ${trace.phase1_completed}`,
    );
  }
  if (trace.phase2_completed !== row.phase2_passed) {
    defects.push(
      `${id}: official phase2_passed ${row.phase2_passed} but trace phase2_completed ${trace.phase2_completed}`,
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
  // Snippets are graded against the LAST submission of the phase: earlier attempts are drafts.
  const lastSubmit = submits.at(-1);
  const ambiguity = datasetRow?.user_query_ambiguity;
  const ambiguities = gradeAmbiguities(
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
    // With no trace there is no initial budget to report, and inventing one would be a number a
    // reader could quote; the missing trace is already a named defect.
    initialBudget: trace?.initial_budget ?? 0,
    modelTurns: trace?.model_turns ?? 0,
    elapsedSeconds: row.elapsed_seconds,
    toolCalls: toolCallsFor(trace),
    goldSql: goldSqlFor(datasetRow),
    submits,
    asks,
    knowledge,
    ambiguities,
    failureClass: classifyPhase({
      passed: phase1Passed,
      tolerantPassed,
      executionFailed: executionFailedResult(lastSubmit?.result ?? ""),
      submitted: submits.length > 0,
      ambiguities,
      missedKnowledge: knowledge.missed.length,
    }),
  };
}

function sum(tasks: readonly ScoredTask[], valueOf: (task: ScoredTask) => number): number {
  return tasks.reduce((total, task) => total + valueOf(task), 0);
}

function rateOver(totalTasks: number): (count: number) => number {
  return (count) => (totalTasks === 0 ? 0 : count / totalTasks);
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
function warningsFor(inputs: RunInputs, tasks: readonly ScoredTask[]): string[] {
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
 * `toolCalls.ask_user` counts the charged calls, the ones that errored included: `tools.ts` records
 * the trajectory entry after the try/catch and the dialogue pair only inside the successful path,
 * so a transport error or an HTTP 500 leaves the call recorded and no dialogue turn. The dialogue's
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
 * submitted, what budget they burned, what the dataset said was ambiguous. Those remain true when
 * the reward does not. The verdicts go because a failure class derived from an untrustworthy run
 * is itself untrustworthy — the recorded VOID run published `intent-miss` five times beside 47
 * withheld cells, pinning on the agent a failure its own page said meant nothing.
 */
function withoutVerdicts(task: ScoredTask): TaskIR {
  return {
    ...task,
    reward: null,
    phase1Passed: null,
    phase2Passed: null,
    tolerantPassed: null,
    failureClass: null,
  };
}

/** The same, for a breakdown row: the census stands, the group's score does not. */
function withoutGroupScores(row: GroupRowIR): GroupRowIR {
  return { ...row, averageReward: null, phase1Count: null };
}

export function buildRunReport(inputs: RunInputs): RunReportIR {
  const defects: string[] = [];
  const tasks: ScoredTask[] = [];
  const scored = new Set(inputs.official.results.map((row) => row.task_id));
  for (const row of inputs.official.results) {
    const trace = inputs.traces[row.task_id];
    const datasetRow = inputs.dataset[row.instance_id];
    defects.push(...defectsFor(row, trace));
    if (datasetRow === undefined) {
      defects.push(`${row.task_id}: no dataset row for instance ${row.instance_id}`);
    }
    const task = buildTask(row, trace, datasetRow, inputs.tolerant);
    const unanswered = unansweredAskDefect(task);
    if (unanswered !== null) defects.push(unanswered);
    tasks.push(task);
  }
  defects.push(...absentFromOfficialDefects(inputs, scored));

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
    warnings: warningsFor(inputs, tasks),
    defects,
    strict,
    tolerant,
    withheld,
    budget: {
      used: sum(tasks, (task) => task.budgetUsed),
      initial: sum(tasks, (task) => task.initialBudget),
      exhaustedTasks: tasks.filter((task) => task.budgetRemaining <= 0).length,
    },
    byDifficulty: publishGroups(groupBy(tasks, (task) => task.difficultyTier)),
    byHighLevel: publishGroups(groupBy(tasks, (task) => String(task.highLevel))),
    difficultyVocabularies: [...new Set(tasks.map((task) => task.difficultyTier))].sort(),
    tasks: publishedTasks,
  };
}
