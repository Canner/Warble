/**
 * Guardrail runtime enforcement — the differentiator over the file target.
 *
 * The file target can only emit static allow/deny *strings* in a settings file. Here the same
 * `read_only_execution` guardrail is enforced at RUNTIME via the SDK `canUseTool` callback: every
 * tool call is inspected as it happens and escapes are intercepted with a reason fed back to the
 * model. Two layers work together:
 *   1. static (options.ts): `Bash` is available but NOT auto-allowed, `Write`/`Edit` absent on the
 *      read-only path, destructive bash patterns in `disallowedTools`;
 *   2. runtime (here): `canUseTool` allows only `wren` bash invocations (data access through the
 *      semantic layer) and, on the prompt flavor, `Write` only inside the artifact scope.
 *
 * Data read-only itself is additionally enforced one layer down by wren `strict_mode` (its own
 * config), which is orthogonal to this artifact/escape gate.
 *
 * See docs/spec/enforcement-seam.md for the full enforcement model across both targets.
 */
import { resolve as resolvePath, sep as pathSep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Whether the already-resolved absolute path `abs` lies within the resolved scope directory
 * `scopeAbs`. A plain `abs.startsWith(scopeAbs)` is WRONG at a directory boundary — it would admit a
 * sibling like `/p/models-export` for a scope of `/p/models`. Require an exact match or a real
 * path-separator boundary after the prefix. Shared by the context_write_authz and writeScope checks.
 */
function withinScope(abs: string, scopeAbs: string): boolean {
  return abs === scopeAbs || abs.startsWith(scopeAbs.endsWith(pathSep) ? scopeAbs : scopeAbs + pathSep);
}

/** A blocked tool call, recorded so the trace/report can prove enforcement actually fired. */
export interface Denial {
  tool: string;
  reason: string;
  command?: string;
}

export interface GuardConfig {
  readOnly: boolean;
  /** Absolute artifact-write scope dir (prompt flavor); null keeps the agent fully read-only. */
  writeScope: string | null;
  /** The session cwd (bound wren project), used to resolve relative write paths. */
  cwd: string;
  /**
   * +Mutating: when set, Write/Edit calls are the gated apply of a mutating component's diff, not a
   * plain artifact write. The actual approval decision is borrowed from the SDK embedder's own
   * `canUseTool` wrapper / approval channel — this guard cannot grant an apply on its own, so it
   * always denies fail-closed and records why (a target with no approval channel is the honest edge,
   * not a bug to route around).
   */
  mutation?: {
    mustDryRun: boolean;
    approvalRequired: boolean;
    /**
     * +Constitutive: the THIRD enforcement point, `context_write_authz` — a path-scoped gate distinct
     * from `writeScope` (render artifact writes) and the plain mutation approval gate (data writes).
     * When set, a Write/Edit outside this scope is denied with a SCOPE-VIOLATION reason (never even
     * reaches the approval question); a write inside the scope still denies fail-closed, but with an
     * APPROVAL reason — same fail-closed philosophy as the unscoped mutation branch below. The two
     * reasons are distinguishable so callers/tests can tell which gate fired. Unset keeps the existing
     * unscoped mutation behavior unchanged.
     */
    contextScope?: string;
  };
  /**
   * +Setup (genbi-setup, the 5th enforcement point: `setup_execution`): the onboarding flavor. When
   * set, Bash is broadened beyond `wren` (connector CLIs like `dlt` are permitted too — still subject
   * to the DESTRUCTIVE/REDIRECTION denylist, checked first and never relaxed), and Write/Edit are
   * scoped to this project root rather than denied outright. Distinct from `writeScope` (render
   * artifacts) and the `mutation` gates (a pre-existing MDL's diff/apply lifecycle): setup has no
   * pre-bound context to gate reads against and no diff to approve — it is scaffolding a NEW project.
   * `undefined`/`null` leaves every other component's behavior unchanged.
   */
  setupScope?: string | null;
}

const DESTRUCTIVE = /\b(rm|sudo|dd|mkfs|shutdown|reboot|kill|chmod|chown|mv|cp)\b/;
const REDIRECTION = /(^|[^>])>>?[^>]/; // shell output redirection → an artifact/warehouse write escape

/** First executable token of a (possibly compound) bash command. */
function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function allow(input: Record<string, unknown>): PermissionResult {
  return { behavior: "allow", updatedInput: input };
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

/**
 * Build the `canUseTool` gate for a component. Denials are pushed into `denials` (return it to the
 * caller for the trace). Fail-closed: anything not explicitly permitted is denied with guidance.
 */
export function makeReadOnlyGuard(cfg: GuardConfig): { canUseTool: CanUseTool; denials: Denial[] } {
  const denials: Denial[] = [];

  const canUseTool: CanUseTool = async (toolName, input) => {
    // Read is always safe.
    if (toolName === "Read" || toolName === "Task" || toolName === "TodoWrite") {
      return allow(input);
    }

    if (toolName === "Bash") {
      const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
      if (DESTRUCTIVE.test(command) || REDIRECTION.test(command)) {
        const reason =
          "destructive or file-writing bash is blocked by the read_only_execution guardrail; " +
          "all data access must go through the read-only `wren` CLI.";
        denials.push({ tool: "Bash", reason, command });
        return deny(reason);
      }
      // +Setup: broadened beyond `wren` (e.g. `dlt` connector CLIs) — the destructive/redirection
      // check above still runs first and is never relaxed for setup.
      if (cfg.setupScope != null) return allow(input);
      if (firstToken(command) !== "wren") {
        const reason =
          "only `wren` CLI invocations are permitted (data access goes through the semantic " +
          "layer); this command is blocked by the read_only_execution guardrail.";
        denials.push({ tool: "Bash", reason, command });
        return deny(reason);
      }
      return allow(input);
    }

    if (toolName === "Write" || toolName === "Edit") {
      if (cfg.mutation) {
        if (cfg.mutation.contextScope) {
          // +Constitutive: context_write_authz — a path-scoped gate, distinct from writeScope
          // (render artifacts) and from the unscoped mutation approval gate below. The scopes must
          // never cross: a data path or a models/knowledge path outside this component's own scope
          // is denied outright, before the approval question is even reached.
          const target = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
          const abs = resolvePath(cfg.cwd, target);
          const scopeAbs = resolvePath(cfg.cwd, cfg.mutation.contextScope);
          if (!withinScope(abs, scopeAbs)) {
            const reason =
              `write to '${target}' is outside the context_write_authz scope '${cfg.mutation.contextScope}'.`;
            denials.push({ tool: toolName, reason, command: target });
            return deny(reason);
          }
          // In scope: the path authorization gate clears, but the apply is still gated on human
          // approval, which this guard does not provide — same fail-closed philosophy as the
          // unscoped mutation branch below, just reached from inside the scope.
          const gate = cfg.mutation.approvalRequired ? "human approval" : "the must_dry_run gate";
          const reason =
            `${toolName} is inside the context_write_authz scope '${cfg.mutation.contextScope}', ` +
            `but the apply still requires ${gate} to clear first; that approval is borrowed from ` +
            "the SDK embedder's own canUseTool/approval channel, which this guard does not " +
            "provide, so it denies by default (fail-closed).";
          denials.push({ tool: toolName, reason, command: target });
          return deny(reason);
        }
        const gate = cfg.mutation.approvalRequired ? "human approval" : "the must_dry_run gate";
        const reason =
          `${toolName} is the gated apply of a mutating component and requires ${gate} to clear ` +
          "first; that approval is borrowed from the SDK embedder's own canUseTool/approval " +
          "channel, which this guard does not provide, so it denies by default (fail-closed).";
        denials.push({ tool: toolName, reason });
        return deny(reason);
      }
      if (cfg.setupScope != null) {
        // +Setup: onboarding writes (a new project's files, an EMPTY .env template, generated MDL)
        // are scoped to the project root, not denied outright — this branch is reached because setup
        // components carry neither `cfg.mutation` nor `cfg.writeScope`.
        const target = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
        const abs = resolvePath(cfg.cwd, target);
        const scopeAbs = resolvePath(cfg.cwd, cfg.setupScope);
        if (withinScope(abs, scopeAbs)) return allow(input);
        const reason = `write to '${target}' is outside the setup project-root scope '${cfg.setupScope}'.`;
        denials.push({ tool: toolName, reason, command: target });
        return deny(reason);
      }
      if (cfg.writeScope) {
        const target = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
        const abs = resolvePath(cfg.cwd, target);
        const scopeAbs = resolvePath(cfg.cwd, cfg.writeScope);
        if (withinScope(abs, scopeAbs)) return allow(input);
        const reason = `write to '${target}' is outside the permitted artifact scope '${cfg.writeScope}'.`;
        denials.push({ tool: toolName, reason, command: target });
        return deny(reason);
      }
      const reason =
        `${toolName} is blocked: this component is read-only (programmatic render flavor keeps the ` +
        `agent from writing files; the dispatcher renders the dashboard from your envelope).`;
      denials.push({ tool: toolName, reason });
      return deny(reason);
    }

    // Fail-closed for anything unexpected.
    const reason = `tool '${toolName}' is not permitted for this component.`;
    denials.push({ tool: toolName, reason });
    return deny(reason);
  };

  return { canUseTool, denials };
}
