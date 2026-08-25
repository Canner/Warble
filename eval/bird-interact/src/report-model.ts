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

/** The strict column: the official scorer's own reward, summed and averaged over the run. */
export interface ScoreIR {
  readonly totalTasks: number;
  readonly totalReward: number;
  readonly averageReward: number;
  readonly phase1Count: number;
  readonly phase1Rate: number;
  readonly phase2Count: number;
  readonly phase2Rate: number;
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
  readonly phase1Rate: number;
  readonly phase2Count: number;
  readonly phase2Rate: number;
}

export interface BudgetIR {
  readonly used: number;
  readonly initial: number;
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
  readonly cost: number;
  readonly budgetBefore: number;
  readonly budgetAfter: number;
  /** What the agent wrote. */
  readonly semanticSql: string;
  /** What Wren planned; `null` when the submission bypassed planning. */
  readonly nativeSql: string | null;
  readonly result: string;
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
  readonly initialBudget: number;
  readonly modelTurns: number;
  readonly elapsedSeconds: number;
  readonly toolCalls: Readonly<Record<string, number>>;
  /**
   * The dataset's `sol_sql` for this task: the answer the benchmark scores against.
   *
   * A list because `sol_sql` is one — a task can be graded on several statements. Empty when no
   * dataset row carried this task, which is already a named defect; an empty list says "gold is
   * unknown here" where a placeholder string would read as a statement someone could quote.
   *
   * **Gated benchmark material** — see `GATED_GROUND_TRUTH_NOTICE`, which every report carries
   * because this field is in it.
   */
  readonly goldSql: readonly string[];
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
  /** Named disagreements between the official record and Warble's own trace. */
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

const scoreSchema = z.object({
  totalTasks: count,
  totalReward: finite,
  averageReward: finite,
  phase1Count: count,
  phase1Rate: finite,
  phase2Count: count,
  phase2Rate: finite,
});

const tolerantScoreSchema = z.object({
  totalTasks: count,
  phase1Count: count,
  phase1Rate: finite,
  phase2Count: count,
  phase2Rate: finite,
});

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
  initialBudget: finite,
  modelTurns: count,
  elapsedSeconds: finite,
  toolCalls: z.record(z.string(), count),
  goldSql: z.array(z.string()),
  submits: z.array(z.object({
    attempt: z.number().int().positive(),
    cost: finite,
    budgetBefore: finite,
    budgetAfter: finite,
    semanticSql: z.string(),
    nativeSql: z.string().nullable(),
    result: z.string(),
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
    .enum(["passed", "passed-tolerant", "no-sql", "exec-error", "intent-miss", "intent-ok"])
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
    budget: z.object({ used: finite, initial: finite, exhaustedTasks: count }),
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
            t.failureClass === null,
        )),
    {
      message:
        "a withheld report must publish no recoverable score: no breakdown average or phase-1 " +
        "count, and no per-task reward, phase verdict or failure class",
      path: ["withheld"],
    },
  )
  .refine((r) => r.withheld !== null || r.strict !== null, {
    message: "a report with no strict score must state why it is withheld",
    path: ["withheld"],
  })
  // And the other direction: `null` means WITHHELD and nothing else, so a reportable run that
  // dropped a verdict cannot pass itself off as one that withheld it.
  .refine(
    (r) =>
      r.withheld !== null ||
      ([...r.byDifficulty, ...r.byHighLevel].every(
        (g) => g.averageReward !== null && g.phase1Count !== null,
      ) &&
        r.tasks.every(
          (t) => t.reward !== null && t.phase1Passed !== null && t.phase2Passed !== null && t.failureClass !== null,
        )),
    {
      message:
        "a report that withholds nothing must state every score: a null breakdown average or " +
        "per-task verdict is reserved for a withheld run",
      path: ["withheld"],
    },
  );

export function parseRunReport(value: unknown): RunReportIR {
  return runReportSchema.parse(value) as RunReportIR;
}
