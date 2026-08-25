import { z } from "zod";

import type { AmbiguityVerdict, FailureClass } from "./report-diagnose.js";
import type { SimulatorHealth } from "./report-simulator.js";

/**
 * The report IR: what the analysis produced, before anything renders it.
 *
 * Analysis and presentation are separated by this document for the same reason the compiler and
 * its back-ends are separated by `ir.json` — tests assert against it, a CI gate can read it, and
 * no number exists only inside a rendered page.
 */

/**
 * What every report says about itself, rendered and machine-readable alike.
 *
 * `TaskIR.goldSql` puts the benchmark's own `sol_sql` on the page — the only way a reader can see
 * WHY a task failed instead of inferring it from a failure-class label. That SQL is gated: BIRD
 * releases it only through its gated process, this package keeps it in a gitignored tree, and it is
 * never committed. A `report.html` is one self-contained file, which is exactly the kind of thing
 * someone forwards without thinking, so the constraint has to travel ON the artifact rather than in
 * a README its recipient never sees.
 *
 * The schema pins it as a literal rather than as any non-empty string: a report that carried a
 * softened version of this sentence would not validate.
 */
export const GATED_GROUND_TRUTH_NOTICE =
  "This report contains BIRD-Interact ground-truth SQL. That ground truth is gated benchmark " +
  "material obtained through BIRD's gated process, and must not be shared outside the terms " +
  "under which it was obtained.";

export interface ProvenanceIR {
  readonly run: string;
  readonly officialCommit: string;
  readonly publicSnapshotCommit: string;
  readonly imageId: string;
  readonly repoDigests: readonly string[];
  readonly wrenVersion: string;
  readonly pythonVersion: string;
  readonly taskIds: readonly string[];
  readonly systemModel: string;
  /**
   * The user-simulator model **the run recorded for itself**, or `null` when it recorded none —
   * an oracle-only run, which never called one, or a run finished before Warble began recording
   * it. `null` renders as *unrecorded*: it is never read back off a live `.env`, which would date
   * the report rather than the run.
   */
  readonly userSimulatorModel: string | null;
}

/**
 * The strict column: the official scorer's own reward, summed and averaged over the run.
 *
 * **Every quotient is `null` when `totalTasks` is 0, and only then.** A run that measured nothing
 * has no average and no rate — the quantity is undefined, not zero — and substituting 0 published
 * "average reward 0.00" and "phase 1 passed 0/0 (0%)" for a run with no tasks in it, three
 * statements about an agent's performance derived from an empty list. Sums and counts stay
 * numbers: an empty sum really is 0, and so is an empty count.
 */
export interface ScoreIR {
  readonly totalTasks: number;
  readonly totalReward: number;
  readonly averageReward: number | null;
  readonly phase1Count: number;
  readonly phase1Rate: number | null;
  readonly phase2Count: number;
  readonly phase2Rate: number | null;
}

/**
 * The tolerant column, which counts TASKS and carries no reward.
 *
 * A tolerant replay yields a verdict per task, not a reward: there is no per-task score to sum, so
 * a `totalReward` here could only ever have been the pass count and an `averageReward` the pass
 * RATE wearing a reward's name. Rendered beside strict's genuine reward average, those two numbers
 * read as one quantity improving — `0.60` against `0.20`, a 3x that is a unit error. The type is
 * the fix: there are no reward-named fields to print.
 */
export interface TolerantScoreIR {
  readonly totalTasks: number;
  readonly phase1Count: number;
  /** `null` when `totalTasks` is 0, and only then — see `ScoreIR`. */
  readonly phase1Rate: number | null;
  readonly phase2Count: number;
  /** `null` when `totalTasks` is 0, and only then — see `ScoreIR`. */
  readonly phase2Rate: number | null;
}

export interface BudgetIR {
  readonly used: number;
  /**
   * The run's initial budget, or `null` when at least one task's is unknown.
   *
   * A task with no Warble trace has no recorded initial budget, and a sum that quietly omitted it
   * would still be printed as the run's budget — and divided into, producing a share of a total
   * that is not the total. `null` says the denominator is not known.
   */
  readonly initial: number | null;
  readonly exhaustedTasks: number;
}

/**
 * One breakdown row. `tasks` is a census and is always reported; the two score fields are `null`
 * on a withheld run, because a group average is a recoverable score like any other.
 */
export interface GroupRowIR {
  readonly key: string;
  readonly tasks: number;
  readonly averageReward: number | null;
  readonly phase1Count: number | null;
}

export interface AskIR {
  readonly question: string;
  readonly answer: string;
  readonly canned: boolean;
}

export interface SubmitIR {
  readonly attempt: number;
  /**
   * The a-interact phase this submission answered, or `null` when the trace did not record one —
   * **and on a withheld run**.
   *
   * A task that clears phase 1 is asked a DIFFERENT question in phase 2, and the trace records the
   * phase on every trajectory entry. Without this field the page put a phase-2 submission beside
   * phase-1 gold with nothing saying so, and the phase-1 ambiguity grades were computed against it
   * — a grade of one question's snippet against another question's SQL.
   *
   * It is withheld with the rest of the verdicts because a submission labelled `phase 2` says the
   * scorer ACCEPTED the phase-1 attempt before it: `phase1Passed` is `null` in the same object and
   * fully recoverable from this number. Unlike `result`, `null` here is not reserved for a withheld
   * run — a trace that recorded no phase produces it too — so only the forward rule is enforceable.
   */
  readonly phase: number | null;
  readonly cost: number;
  readonly budgetBefore: number;
  readonly budgetAfter: number;
  /** What the agent wrote. */
  readonly semanticSql: string;
  /** What Wren planned; `null` when the submission bypassed planning. */
  readonly nativeSql: string | null;
  /**
   * What the scorer said back, or `null` on a withheld run — and `null` means that and nothing else.
   *
   * This is the scorer speaking, not the agent: `SQL failed Phase 1.`, `Phase 1 correct! (Reward:
   * 0.7). Moving to Phase 2.` It was the last route out of a withheld report. The recorded VOID run
   * published sixteen of these, every one of them saying the submission failed phase 1, which is the
   * exact figure — 0 of 5 tasks passed — that withholding exists to suppress, quotable verbatim off
   * a page whose every reward cell read *withheld*.
   *
   * Nothing the run legitimately carries is lost by dropping it: the attempt number, the cost, the
   * budget either side and both SQL statements are their own typed fields, and the only other thing
   * this string holds — `Budget remaining: N bird-coins` — is `budgetAfter` restated in prose.
   */
  readonly result: string | null;
}

export interface KnowledgeIR {
  readonly required: readonly number[];
  /** Entries `knowledge_ambiguity[].deleted_knowledge` hid from the agent's view. */
  readonly withheld: readonly number[];
  /** Withheld entries whose definition reached the agent through `ask_user`. */
  readonly recovered: readonly number[];
  /** Required entries the agent never obtained by any route. */
  readonly missed: readonly number[];
}

export interface TaskIR {
  readonly taskId: string;
  readonly database: string;
  readonly category: string;
  readonly difficultyTier: string;
  readonly highLevel: boolean;
  /**
   * Every per-task verdict below is `null` on a withheld run, and only then.
   *
   * A withheld run publishes no score at ALL — not the headline, not a breakdown average, and not
   * a per-task reward or failure class. The rule is enforced in the schema rather than left to a
   * renderer: the recorded VOID run's `report.html` masked its reward cells while printing a
   * per-task failure class beside them, so the same page said no score from this run means
   * anything and pinned the failure on the agent five times over.
   */
  readonly reward: number | null;
  readonly phase1Passed: boolean | null;
  readonly phase2Passed: boolean | null;
  /** `null` when no autopsy produced a tolerant verdict, and on a withheld run. */
  readonly tolerantPassed: boolean | null;
  readonly budgetUsed: number;
  readonly budgetRemaining: number;
  /**
   * The budget the task started with, or `null` when Warble kept no trace of it.
   *
   * The initial budget lives only in Warble's trace, so with no trace there is no denominator.
   * Substituting 0 rendered `18 / 0` — a task that used more than all of a budget it never had.
   */
  readonly initialBudget: number | null;
  readonly modelTurns: number;
  readonly elapsedSeconds: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  /**
   * The dataset's phase-1 `sol_sql` for this task: the answer the benchmark scores phase 1 against.
   *
   * A list because `sol_sql` is one — a task can be graded on several statements. Empty when no
   * dataset row carried this task, which is already a named defect; an empty list says "gold is
   * unknown here" where a placeholder string would read as a statement someone could quote.
   *
   * **Phase 1 only**, and `followUpGoldSql` is the other phase. A page that showed one gold beside
   * submissions from both phases implied a correspondence that does not hold.
   *
   * **Gated benchmark material** — see `GATED_GROUND_TRUTH_NOTICE`, which every report carries
   * because this field is in it.
   */
  readonly goldSql: readonly string[];
  /**
   * The dataset's `follow_up.sol_sql`: the answer phase 2's different question is scored against.
   *
   * Also gated, and empty when the row carries no follow-up. Normalised to a list because the
   * dataset stores it both ways — a bare string on most rows, a list on the rest.
   */
  readonly followUpGoldSql: readonly string[];
  readonly submits: readonly SubmitIR[];
  readonly asks: readonly AskIR[];
  readonly knowledge: KnowledgeIR;
  readonly ambiguities: readonly AmbiguityVerdict[];
  /** `null` on a withheld run: with no trustworthy verdict there is no class to publish. */
  readonly failureClass: FailureClass | null;
}

export interface RunReportIR {
  readonly version: 1;
  readonly generatedAt: string;
  /** Always `GATED_GROUND_TRUTH_NOTICE`; the schema accepts no other wording. */
  readonly gatedNotice: string;
  readonly provenance: ProvenanceIR;
  readonly simulator: SimulatorHealth;
  readonly warnings: readonly string[];
  /**
   * Named disagreements between the official record and Warble's own trace.
   *
   * **Not masked on a withheld run, and deliberately so.** A defect is a statement about the
   * RECORD, not about the agent: dropping it would delete the very anomaly that justifies
   * withholding, and a reader of a withheld report is exactly the reader who needs to know the two
   * files disagree. What is masked is only the VALUES a disagreement quotes — `official reward 0.7
   * but trace reward 0` states a reward twice — so a withheld report names the disagreement and
   * withholds both sides of it. Learning that two records disagree about phase 1 does not tell you
   * which of them said it passed; `statesAnOutcome` enforces the line between the two.
   */
  readonly defects: readonly string[];
  /** `null` only when `withheld` states why. */
  readonly strict: ScoreIR | null;
  /** `null` when no autopsy computed it, or when scores are withheld. */
  readonly tolerant: TolerantScoreIR | null;
  /** The reason scores are withheld, or `null` when they are reportable. */
  readonly withheld: string | null;
  readonly budget: BudgetIR;
  readonly byDifficulty: readonly GroupRowIR[];
  readonly byHighLevel: readonly GroupRowIR[];
  /**
   * The distinct `difficulty_tier` vocabularies present.
   *
   * The dataset carries `Simple`/`Moderate`/`Challenging` on most rows and `Easy`/`Medium`/`Hard`
   * on the rest. The breakdown reports both verbatim; folding them together is a mapping this
   * package has no authority to make.
   */
  readonly difficultyVocabularies: readonly string[];
  readonly tasks: readonly TaskIR[];
}

const finite = z.number().finite();
const count = z.number().int().nonnegative();

/**
 * A quotient over the run's tasks: `null` exactly when there were none.
 *
 * The `.refine` below pins the "exactly" in both directions, so `null` cannot come to mean
 * anything else and a rate can never be 0 for want of a denominator.
 */
const rate = finite.nullable();

const scoreSchema = z.object({
  totalTasks: count,
  totalReward: finite,
  averageReward: rate,
  phase1Count: count,
  phase1Rate: rate,
  phase2Count: count,
  phase2Rate: rate,
});

const tolerantScoreSchema = z.object({
  totalTasks: count,
  phase1Count: count,
  phase1Rate: rate,
  phase2Count: count,
  phase2Rate: rate,
});

/**
 * A score block states every quotient it has, or — with no tasks to divide by — none of them.
 *
 * Both directions matter. A `null` on a run that DID score tasks would be a rate dropped by
 * accident wearing the "undefined" spelling, and a number on a run that scored none is the zero
 * this rule exists to keep off the page.
 */
function quotientsMatchTaskCount(
  totalTasks: number,
  quotients: readonly (number | null)[],
): boolean {
  const measured = totalTasks > 0;
  return quotients.every((q) => (q !== null) === measured);
}

/**
 * The shapes free text takes when it states an outcome the scorer decided.
 *
 * These are the sentences `db_environment/server.py` writes back on a submission and the two defect
 * templates that quote a verdict — nothing else in this package produces them. A regular expression
 * is a blocklist, and a blocklist over free text can only ever be a tripwire rather than a proof;
 * it is here because the alternative is no rule at all on the two fields that are unavoidably
 * prose. Every field that CAN be typed is typed and nulled instead, and this guards what is left.
 *
 * Add a pattern when a new sentence starts stating a verdict. Do not loosen one to make a new
 * defect line fit: reword the defect so it names the disagreement without the values, which is
 * what a withheld report is supposed to say anyway.
 */
const OUTCOME_PATTERNS: readonly RegExp[] = [
  /** A stated reward: `Reward: 0.7`, `official reward 0 but trace reward 1`. */
  /\breward\b\W{0,3}[-+]?\d/i,
  /**
   * A stated phase verdict: `phase1_passed true`, `phase2_completed false`.
   *
   * No leading `\b`, deliberately: `_` is a word character, so `\bpassed` never matches inside
   * `phase1_passed` — which is the only spelling this package writes.
   */
  /(?:passed|completed)\b\W{0,3}(?:true|false)\b/i,
  /** The scorer's own sentence, either way it lands: `Phase 1 correct!`, `SQL failed Phase 1.` */
  /\bphase \d\b[^.\n]{0,24}\b(?:correct|passed|failed)\b/i,
  /\b(?:correct|passed|failed)\b[^.\n]{0,24}\bphase \d\b/i,
  /**
   * The environment refusing to run the SQL, which is the same verdict by another route: a
   * submission that never executed is a submission the scorer did not accept, and `failureClass`
   * reads `exec-error` straight off these two messages. Both spellings, because `tools.ts` strips
   * the marker from what it records while the official row keeps it — see `report-build.ts`.
   */
  /\[exec_err_flg\]/i,
  /\bError executing submitted SQL\b/i,
  /\bSubmitted SQL execution timed out\b/i,
];

/**
 * Whether a line of free text tells the reader what the scorer decided.
 *
 * The withholding rule is "no recoverable score", and every field that can carry one as a NUMBER or
 * a BOOLEAN is typed `| null` and masked. Two fields cannot be: `SubmitIR.result` is whatever the
 * benchmark server said, and `RunReportIR.defects` is a sentence naming a disagreement. `result` is
 * nulled outright; a defect has to survive, so it is this predicate the schema holds it to.
 *
 * Exported because the same question is asked in three places — the schema refinement, the builder
 * that writes the masked defect lines, and the test that scans a regenerated artifact — and three
 * separate spellings of it would drift apart.
 */
export function statesAnOutcome(text: string): boolean {
  return OUTCOME_PATTERNS.some((pattern) => pattern.test(text));
}

const matchSchema = z.enum(["exact", "columns", "miss", "inconclusive"]);

const ambiguitySchema = z.object({
  term: z.string(),
  type: z.string(),
  isMask: z.boolean(),
  critical: z.boolean(),
  match: matchSchema,
});

const taskSchema = z.object({
  taskId: z.string().min(1),
  database: z.string().min(1),
  category: z.string().min(1),
  difficultyTier: z.string(),
  highLevel: z.boolean(),
  reward: finite.nullable(),
  phase1Passed: z.boolean().nullable(),
  phase2Passed: z.boolean().nullable(),
  tolerantPassed: z.boolean().nullable(),
  budgetUsed: finite,
  budgetRemaining: finite,
  initialBudget: finite.nullable(),
  modelTurns: count,
  elapsedSeconds: finite,
  toolCalls: z.record(z.string(), count),
  goldSql: z.array(z.string()),
  followUpGoldSql: z.array(z.string()),
  submits: z.array(z.object({
    attempt: z.number().int().positive(),
    phase: z.number().int().positive().nullable(),
    cost: finite,
    budgetBefore: finite,
    budgetAfter: finite,
    semanticSql: z.string(),
    nativeSql: z.string().nullable(),
    result: z.string().nullable(),
  })),
  asks: z.array(z.object({ question: z.string(), answer: z.string(), canned: z.boolean() })),
  knowledge: z.object({
    required: z.array(z.number().int()),
    withheld: z.array(z.number().int()),
    recovered: z.array(z.number().int()),
    missed: z.array(z.number().int()),
  }),
  ambiguities: z.array(ambiguitySchema),
  failureClass: z
    .enum([
      "passed",
      "passed-tolerant",
      "no-record",
      "no-sql",
      "exec-error",
      "intent-miss",
      "intent-ok",
      "intent-ungraded",
    ])
    .nullable(),
});

const groupSchema = z.object({
  key: z.string(),
  tasks: count,
  averageReward: finite.nullable(),
  phase1Count: count.nullable(),
});

export const runReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1),
    gatedNotice: z.literal(GATED_GROUND_TRUTH_NOTICE),
    provenance: z.object({
      run: z.string().min(1),
      officialCommit: z.string().min(1),
      publicSnapshotCommit: z.string().min(1),
      imageId: z.string().min(1),
      repoDigests: z.array(z.string()),
      wrenVersion: z.string().min(1),
      pythonVersion: z.string().min(1),
      taskIds: z.array(z.string().min(1)),
      systemModel: z.string().min(1),
      userSimulatorModel: z.string().nullable(),
    }),
    simulator: z.object({
      llmCallFailures: count,
      asks: count,
      answered: count,
      cannedResponses: count,
      verdict: z.enum(["healthy", "degraded", "void"]),
    }),
    warnings: z.array(z.string()),
    defects: z.array(z.string()),
    strict: scoreSchema.nullable(),
    tolerant: tolerantScoreSchema.nullable(),
    withheld: z.string().min(1).nullable(),
    budget: z.object({ used: finite, initial: finite.nullable(), exhaustedTasks: count }),
    byDifficulty: z.array(groupSchema),
    byHighLevel: z.array(groupSchema),
    difficultyVocabularies: z.array(z.string()),
    tasks: z.array(taskSchema),
  })
  // A withheld report that still states a score defeats the whole point of withholding it.
  .refine((r) => r.withheld === null || (r.strict === null && r.tolerant === null), {
    message: "a withheld report must carry no strict or tolerant score",
    path: ["withheld"],
  })
  /**
   * The envelope covers every route back to the number, not only the headline.
   *
   * A withheld report that published `byDifficulty[].averageReward` or `tasks[].reward` hands the
   * suppressed score straight back to anything reading `report.json` — which is the CI-gate
   * consumer this IR exists for. Masking those cells in one renderer is not the guarantee the
   * schema claims to enforce, so the schema enforces it.
   */
  .refine(
    (r) =>
      r.withheld === null ||
      ([...r.byDifficulty, ...r.byHighLevel].every(
        (g) => g.averageReward === null && g.phase1Count === null,
      ) &&
        r.tasks.every(
          (t) =>
            t.reward === null &&
            t.phase1Passed === null &&
            t.phase2Passed === null &&
            t.tolerantPassed === null &&
            t.failureClass === null &&
            // The submission is the last route out, and it is two fields wide. `result` is the
            // scorer's own sentence — `SQL failed Phase 1.` repeated sixteen times reconstructs
            // "0 of 5 passed" exactly — and `phase 2` on a submission says the scorer accepted the
            // attempt before it. Everything else about the submission stands; see `SubmitIR`.
            t.submits.every((sub) => sub.result === null && sub.phase === null),
        )),
    {
      message:
        "a withheld report must publish no recoverable score: no breakdown average or phase-1 " +
        "count, no per-task reward, phase verdict or failure class, and no submission outcome " +
        "or submission phase",
      path: ["withheld"],
    },
  )
  /**
   * The defect array, which is the one place a withheld report still speaks in prose.
   *
   * A defect is not masked away — see `RunReportIR.defects` for why deleting it would be worse than
   * publishing it — but the two templates that quote a verdict (`official reward 0.7 but trace
   * reward 0`, `official phase1_passed true but trace phase1_completed false`) hand back exactly
   * what the rest of the report withheld. The builder writes a value-free wording for a withheld
   * run; this is what makes that a guarantee rather than a habit.
   */
  .refine((r) => r.withheld === null || r.defects.every((d) => !statesAnOutcome(d)), {
    message:
      "a withheld report must publish no defect that states an outcome: name the disagreement, " +
      "never either side of it",
    path: ["defects"],
  })
  .refine((r) => r.withheld !== null || r.strict !== null, {
    message: "a report with no strict score must state why it is withheld",
    path: ["withheld"],
  })
  /**
   * A run that measured nothing has no average and no rate.
   *
   * `0` is a measurement; the quotient over zero tasks is not one. An empty run used to publish
   * "average reward 0.00" and "phase 1 passed 0/0 (0%)" and validate, so the rule is here rather
   * than left to whoever computes the division.
   */
  .refine(
    (r) =>
      (r.strict === null ||
        quotientsMatchTaskCount(r.strict.totalTasks, [
          r.strict.averageReward,
          r.strict.phase1Rate,
          r.strict.phase2Rate,
        ])) &&
      (r.tolerant === null ||
        quotientsMatchTaskCount(r.tolerant.totalTasks, [
          r.tolerant.phase1Rate,
          r.tolerant.phase2Rate,
        ])),
    {
      message:
        "a rate or average is null exactly when the run scored no tasks: a run with tasks must " +
        "state every quotient, and a run with none must state no quotient",
      path: ["strict"],
    },
  )
  // And the other direction: `null` means WITHHELD and nothing else, so a reportable run that
  // dropped a verdict cannot pass itself off as one that withheld it.
  .refine(
    (r) =>
      r.withheld !== null ||
      ([...r.byDifficulty, ...r.byHighLevel].every(
        (g) => g.averageReward !== null && g.phase1Count !== null,
      ) &&
        r.tasks.every(
          (t) =>
            t.reward !== null &&
            t.phase1Passed !== null &&
            t.phase2Passed !== null &&
            t.failureClass !== null &&
            // `result` too, so `null` there means WITHHELD and nothing else. `phase` is exempt: a
            // trace that recorded no phase legitimately yields `null` on a reportable run, so only
            // the forward rule can be enforced for it.
            t.submits.every((sub) => sub.result !== null),
        )),
    {
      message:
        "a report that withholds nothing must state every score: a null breakdown average, " +
        "per-task verdict or submission outcome is reserved for a withheld run",
      path: ["withheld"],
    },
  );

export function parseRunReport(value: unknown): RunReportIR {
  return runReportSchema.parse(value) as RunReportIR;
}
