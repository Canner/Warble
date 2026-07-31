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
import type {
  CanUseTool,
  HookCallbackMatcher,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

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
   * to the DESTRUCTIVE/REDIRECTION/dotenv-read denylist, checked first and never relaxed), and
   * Write/Edit are scoped to this project root rather than denied outright, and Read is denied for a
   * dotenv-shaped path (see DOTENV_READER_COMMANDS/DOTENV_PATH below). Distinct from `writeScope`
   * (render artifacts) and the `mutation` gates (a pre-existing MDL's diff/apply lifecycle): setup has
   * no pre-bound context to gate reads against and no diff to approve — it is scaffolding a NEW
   * project. `undefined`/`null` leaves every other component's behavior unchanged.
   */
  setupScope?: string | null;
}

const DESTRUCTIVE = /\b(rm|sudo|dd|mkfs|shutdown|reboot|kill|chmod|chown|mv|cp)\b/;
const REDIRECTION = /(^|[^>])>>?[^>]/; // shell output redirection → an artifact/warehouse write escape

/**
 * Reader commands that can print a file's contents: `cat`, `head`, `tail`, `less`, `more`, `od`,
 * `xxd`, `strings`, `grep`, `awk`, `sed`. Matched as a whole word (`\b`) so a lookalike substring
 * inside another word — `cat` inside "concatenate", `sed` inside "used", `od` inside "produce" —
 * never matches.
 *
 * DOTENV_READER_COMMANDS and DOTENV_PATH (below), and the pairing that uses them in `canUseTool`'s
 * Bash and Read branches, are the ORIGINAL that the genbi in-process setup tool copies verbatim (see
 * `apps/genbi/harness/tools/setup-native.ts`'s `DOTENV_READER_COMMANDS`/`DOTENV_PATH` in the public
 * WrenAI repo) — deliberately, so the two setup boundaries cannot drift apart. Keep both regexes
 * byte-identical across the two files; changing one without the other reopens the gap this closes.
 *
 * The gap: the setup credential design writes an EMPTY `.env` template and relies on the agent never
 * reading the filled-in values back (the user fills them out-of-band) — but until this pair existed,
 * nothing enforced that. Observed live (real model, genbi in-process copy): a setup agent ran `cat
 * <project>/.env`, it succeeded (neither DESTRUCTIVE nor REDIRECTION matches a plain read), and the
 * full stdout — a connection string / password / API key / service-account value — reached both the
 * model's own context and the host app's persisted turn trace.
 *
 * Note for anyone auditing this the way that genbi incident was found: warble itself has no
 * counterpart to genbi's output-redaction layer, and intentionally so — `trace.json` (see `Trace` in
 * run.ts) only ever persists metadata (`target, verb, model, split, run, usage, modelUsage, steps,
 * denials`), never raw tool stdout/stderr. There is no persistence choke point in warble for a leaked
 * secret to land in on disk the way it did in genbi's turn trace; the exposure this pair (and the
 * PreToolUse hook below, for Read) closes is the model's own context window, not a stored artifact.
 */
const DOTENV_READER_COMMANDS = /\b(cat|head|tail|less|more|od|xxd|strings|grep|awk|sed)\b/;
/**
 * A `.env`/`.env.<suffix>` path token (`.env`, `project/.env`, `.env.local`, `.env.production`, …),
 * matched precisely: the literal `.env` must be preceded by start-of-string/whitespace/quote/`/`/`=`
 * and followed by end-of-string/whitespace/quote/`/`, with an optional `.<suffix>` in between. This is
 * what keeps a file named `.environment` (no boundary right after `.env` — the next character is `i`,
 * not one of the above) and a bare directory named `env/` (no leading dot at all) from tripping the
 * match, even though both contain the substring "env" — both are exercised in
 * `tests/guardrails.test.ts`.
 */
const DOTENV_PATH = /(^|[\s"'/=])\.env(\.[\w.-]+)?(?=$|[\s"'/])/;

/**
 * Whether `text` references a dotenv-shaped path at all. Used two ways: paired with
 * `DOTENV_READER_COMMANDS` against a Bash command string (either alone is over- or under-broad — a
 * reader command alone would deny an unrelated `cat notes.txt`; the path token alone would deny a
 * command that merely mentions ".env" as a substring of something else — the pairing is load-bearing),
 * and unpaired against a Read tool's `file_path` (Read has no accompanying "reader command" to pair
 * against — the tool call itself IS the read).
 */
function referencesDotenvPath(text: string): boolean {
  return DOTENV_PATH.test(text);
}

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
 * The LIVE enforcement point for the Read-side of the dotenv-read gap under +Setup — NOT the `Read`
 * branch inside `canUseTool` above, which is dead code against the real SDK for any in-cwd path (see
 * that branch's comment for the empirical evidence). `PreToolUse` hooks are a structurally separate
 * control path from `canUseTool`: the SDK's internal `checkPermissions` auto-allow for in-cwd Read
 * happens before the `canUseTool` callback, but it does NOT suppress `PreToolUse` — confirmed
 * empirically (throwaway `query()` probes against the bundled CLI) that this hook fires for an in-cwd
 * Read of `.env` with `hook_event_name: "PreToolUse"`, `tool_name: "Read"`, `tool_input.file_path` set,
 * even in the same run where `canUseTool` sees zero invocations for that call.
 *
 * Only wired in when `cfg.setupScope != null` (the caller passes an empty array of matchers
 * otherwise, so this never changes behavior for read_only_execution/artifact_write/data_write/
 * context_write_authz components — those don't use setupScope and are unaffected).
 */
function makeSetupReadDenyHook(cfg: GuardConfig, denials: Denial[]): HookCallbackMatcher[] {
  if (cfg.setupScope == null) return [];
  return [
    {
      matcher: "Read",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse") return { continue: true };
          const toolInput = input.tool_input as Record<string, unknown> | null | undefined;
          const target =
            toolInput != null && typeof toolInput["file_path"] === "string"
              ? (toolInput["file_path"] as string)
              : "";
          if (!referencesDotenvPath(target)) return { continue: true };
          const reason =
            "reading a dotenv path via Read is blocked by the read_only_execution guardrail; the " +
            "setup credential design writes an empty .env template and is never meant to read it back.";
          denials.push({ tool: "Read", reason, command: target });
          return {
            continue: false,
            decision: "block",
            reason,
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
        },
      ],
    },
  ];
}

/**
 * Build the `canUseTool` gate for a component, plus the `PreToolUse` hooks needed to actually enforce
 * the +Setup dotenv-read gap's Read side (see `makeSetupReadDenyHook`'s comment — `canUseTool` alone
 * does not reach in-cwd Read in the real SDK). Both share the same `denials` array so the trace sees
 * every enforcement point that fired, however it fired. Callers MUST wire `hooks` into the `query()`
 * `Options.hooks.PreToolUse` for every invocation this guard's `canUseTool` is passed to — passing one
 * without the other leaves the Read side unenforced for +Setup. `hooks` is `[]` for every non-setup
 * component (readOnly/writeScope/mutation/context_write_authz), so wiring it unconditionally is safe
 * and does not change behavior for those paths.
 *
 * Fail-closed: anything not explicitly permitted by `canUseTool` is denied with guidance.
 */
export function makeReadOnlyGuard(
  cfg: GuardConfig,
): { canUseTool: CanUseTool; denials: Denial[]; hooks: HookCallbackMatcher[] } {
  const denials: Denial[] = [];
  const hooks = makeSetupReadDenyHook(cfg, denials);

  const canUseTool: CanUseTool = async (toolName, input) => {
    // Read: this branch is DEAD CODE against the real SDK for any in-cwd path, and is kept only as
    // defense-in-depth for a future SDK version. Confirmed empirically (throwaway query() probes
    // against the bundled CLI, both with `allowedTools: ["Read"]` and `allowedTools: []`): the SDK's
    // internal `checkPermissions` auto-resolves `{behavior:"allow"}` for any path inside the session
    // cwd/`additionalDirectories` BEFORE this developer `canUseTool` callback ever runs — the callback
    // is simply never invoked for Read there, so this dotenv check below cannot fire in practice. The
    // live enforcement point is the `PreToolUse` hook built by `makeSetupReadDenyHook` below, which
    // DOES fire for in-cwd Read (hooks are a structurally separate control path from `canUseTool` —
    // confirmed by the same probes). This branch would only matter for a Read outside cwd/
    // additionalDirectories, which setup components don't produce, so treat it as inert today.
    if (toolName === "Read") {
      if (cfg.setupScope != null) {
        const target = typeof input["file_path"] === "string" ? (input["file_path"] as string) : "";
        if (referencesDotenvPath(target)) {
          const reason =
            "reading a dotenv path via Read is blocked by the read_only_execution guardrail; the " +
            "setup credential design writes an empty .env template and is never meant to read it back.";
          denials.push({ tool: "Read", reason, command: target });
          return deny(reason);
        }
      }
      return allow(input);
    }
    if (toolName === "Task" || toolName === "TodoWrite") {
      return allow(input);
    }

    if (toolName === "Bash") {
      const command = typeof input["command"] === "string" ? (input["command"] as string) : "";
      // Dotenv-read pair: checked FIRST and unconditionally, before DESTRUCTIVE/REDIRECTION and
      // before the setupScope branch below. Either regex alone is over-broad (see
      // DOTENV_READER_COMMANDS/DOTENV_PATH's doc comments above) — the pairing is load-bearing and
      // is never relaxed, exactly like DESTRUCTIVE/REDIRECTION.
      if (DOTENV_READER_COMMANDS.test(command) && referencesDotenvPath(command)) {
        const reason =
          "reading a dotenv file's contents is blocked by the read_only_execution guardrail; the " +
          "setup credential design writes an empty .env template and is never meant to read it back.";
        denials.push({ tool: "Bash", reason, command });
        return deny(reason);
      }
      if (DESTRUCTIVE.test(command) || REDIRECTION.test(command)) {
        const reason =
          "destructive or file-writing bash is blocked by the read_only_execution guardrail; " +
          "all data access must go through the read-only `wren` CLI.";
        denials.push({ tool: "Bash", reason, command });
        return deny(reason);
      }
      // +Setup: broadened beyond `wren` (e.g. `dlt` connector CLIs) — the destructive/redirection
      // and dotenv-read checks above still run first and are never relaxed for setup.
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

  return { canUseTool, denials, hooks };
}
