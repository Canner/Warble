export type BirdToolName =
  | "execute_sql"
  | "get_schema"
  | "get_all_column_meanings"
  | "get_column_meaning"
  | "get_all_external_knowledge_names"
  | "get_knowledge_definition"
  | "get_all_knowledge_definitions"
  | "ask_user"
  | "submit_sql";

export interface DialogueEntry {
  role: "agent" | "user";
  content: string;
}

export interface ToolTrajectoryEntry {
  type: "tool";
  tool: BirdToolName;
  args: Record<string, unknown>;
  result: string;
  cost: number;
  budget_before: number;
  budget_after: number;
  phase: number;
  semantic_sql?: string;
  native_sql?: string;
  /**
   * Why a query-like statement carries no `native_sql`: Wren declined to plan it and the semantic
   * form went upstream unchanged.
   *
   * Without this, a planning outage is indistinguishable from a management statement that never
   * needed planning, and an autopsy of a task that scored 0 on valid SQL has nothing pointing at
   * the planner.
   */
  planner_error?: string;
}

export interface RejectedAction {
  tool: BirdToolName;
  charged: false;
  budget: number;
  reason: string;
}

export interface BirdSessionState {
  task_id: string;
  db_name: string;
  user_query: string;
  current_phase: number;
  budget_remaining: number;
  initial_budget: number;
  total_reward: number;
  dialogue_history: DialogueEntry[];
  tool_trajectory: ToolTrajectoryEntry[];
  adk_events: unknown[];
  phase1_completed: boolean;
  phase2_completed: boolean;
  task_done: boolean;
  model_turns?: number;
  sdk_session_id?: string;
  rejected_actions?: RejectedAction[];
  _last_submit_raw?: string;
  [key: string]: unknown;
}

export interface SubmitSqlResponse {
  passed: boolean;
  message: string;
  reward?: number;
  phase_completed?: 1 | 2 | null;
  has_follow_up?: boolean;
  follow_up_query?: string | null;
}

export type ActionDecision =
  | {
      kind: "execute";
      cost: number;
      budgetBefore: number;
      budgetAfter: number;
      forcedExit: boolean;
    }
  | {
      kind: "reject";
      cost: 0;
      requiredCost: number;
      budgetBefore: number;
      budgetAfter: number;
      message: string;
    };

export interface BudgetInputs {
  critical: number;
  knowledge: number;
  patience: number;
}
