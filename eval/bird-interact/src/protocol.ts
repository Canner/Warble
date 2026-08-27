import type {
  ActionDecision,
  BirdSessionState,
  BirdToolName,
  BudgetInputs,
  SubmitSqlResponse,
} from "./types.js";

export const BIRD_INTERACT_MODE = "a-interact" as const;
export const INITIAL_BUDGET_FORMULA_VERSION = "adk-ainteract-v1" as const;

export const BIRD_SERVICE_PORTS = Object.freeze({
  system_agent: 6000,
  user_simulator: 6001,
  db_environment: 6002,
});

export const BIRD_HTTP_PATHS = Object.freeze({
  system_agent: Object.freeze({
    health: "/health",
    init_session: "/init_session",
    run_session: "/run_session",
  }),
  db_environment: Object.freeze({
    execute: "/execute",
    schema: "/schema",
    all_column_meanings: "/all_column_meanings",
    column_meaning: "/column_meaning",
    knowledge_names: "/knowledge_names",
    knowledge: "/knowledge",
    submit: "/submit",
  }),
  user_simulator: Object.freeze({
    ask: "/ask",
    phase_transition: "/phase_transition",
  }),
});

export const TOOL_COSTS = Object.freeze({
  execute_sql: 1,
  get_schema: 1,
  get_all_column_meanings: 1,
  get_column_meaning: 0.5,
  get_all_external_knowledge_names: 0.5,
  get_knowledge_definition: 0.5,
  get_all_knowledge_definitions: 1,
  ask_user: 2,
  submit_sql: 3,
} satisfies Record<BirdToolName, number>);

export function calculateInitialBudget(inputs: BudgetInputs): number {
  return 6 + 2 * (inputs.critical + inputs.knowledge) + 2 * inputs.patience;
}

/**
 * Match Python's one-decimal, round-half-to-even formatting used by callbacks.py.
 *
 * `f"{v:.1f}"` rounds the double's TRUE binary value, and reaches for half-to-even only when that
 * value IS the midpoint. Hardly any `x.x5` budget is one: `0.25` is exactly representable, so
 * Python breaks the real tie downward to `0.2`; `0.35` is really 0.34999999999999997… and rounds
 * DOWN to `0.3`; `0.45` is really 0.45000000000000001… and rounds UP to `0.5`. Judging the
 * midpoint by a tolerance calls all three of those ties and gets two of them wrong, because the
 * values nearest the midpoint are exactly the ones that are not ties — it is the wrong question.
 *
 * So the remainder is compared exactly rather than approximately: the mantissa and exponent give
 * `value * 10` as a ratio of integers, and `2 * remainder === denominator` can hold only when the
 * tie is real. `toFixed` is no substitute — it breaks a genuine tie away from zero, turning
 * Python's `0.2` into `0.3`.
 *
 * The domain is the finite doubles: `server.ts` admits a budget through `z.number().finite()`, and
 * the ledger only ever subtracts a cost from an integer.
 */
export function formatBirdBudget(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = (bits >> 52n) & 0x7ffn;
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  const mantissa = exponent === 0n ? fraction : fraction | 0x10_0000_0000_0000n;
  const power = (exponent === 0n ? 1n : exponent) - 1075n;
  const numerator = mantissa * 10n * (power > 0n ? 1n << power : 1n);
  const denominator = power < 0n ? 1n << -power : 1n;
  const tenths = numerator / denominator;
  const doubledRemainder = (numerator % denominator) * 2n;
  const rounded =
    doubledRemainder > denominator ||
    (doubledRemainder === denominator && tenths % 2n === 1n)
      ? tenths + 1n
      : tenths;
  return `${bits >> 63n === 1n ? "-" : ""}${rounded / 10n}.${rounded % 10n}`;
}

export function beginAction(
  state: Readonly<BirdSessionState>,
  tool: BirdToolName,
): ActionDecision {
  const budget = state.budget_remaining;
  const cost = TOOL_COSTS[tool];
  if (budget < cost && tool !== "submit_sql") {
    return {
      kind: "reject",
      cost: 0,
      requiredCost: cost,
      budgetBefore: budget,
      budgetAfter: budget,
      message:
        `Budget exhausted (${formatBirdBudget(budget)} remaining). ` +
        "You MUST call submit_sql now with your best SQL.",
    };
  }

  const remaining = budget - cost;
  const forcedExit = tool === "submit_sql" && remaining <= 0;
  return {
    kind: "execute",
    cost,
    budgetBefore: budget,
    budgetAfter: forcedExit ? -1 : remaining,
    forcedExit,
  };
}

export function applySubmitResponse(
  state: Readonly<BirdSessionState>,
  response: Readonly<SubmitSqlResponse>,
): BirdSessionState {
  const next: BirdSessionState = {
    ...state,
    dialogue_history: [...state.dialogue_history],
    tool_trajectory: [...state.tool_trajectory],
    adk_events: [...state.adk_events],
    ...(state.rejected_actions
      ? { rejected_actions: [...state.rejected_actions] }
      : {}),
    _last_submit_raw: response.message,
  };

  if (response.passed) {
    next.total_reward += response.reward ?? 0;
    if (response.phase_completed === 1) {
      next.phase1_completed = true;
      next.current_phase = 2;
      next.task_done = !(response.has_follow_up ?? false);
    } else if (response.phase_completed === 2) {
      next.phase2_completed = true;
      next.task_done = true;
    }
  }
  return next;
}
