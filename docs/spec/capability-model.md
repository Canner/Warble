# Warble capability model — dispatch as capability negotiation

> The unifying mechanism behind every "wall-hit". Dispatch is not just IR→files translation; it is
> a **capability linker**: it resolves each capability the IR requires against the target runtime's
> **capability profile**, and for each one chooses native / realize-via / degrade / fail. This is
> the LLVM "target-feature legalization" step applied to data-agent behavior.
> Status: design (agreed direction). Subsumes the per-feature designs in `ir-schema.md` §v0.2
> (per-step tier) and §v0.3 (render contract), and the open wall-hits #3 (semantic guardrails) and
> #5 (triggers).

---

## 1. A runtime target is `engine × mode × host-surface`

The unit dispatch links against is **not** "Claude Code" but a specific target with a concrete
capability set. The same engine in different modes is a **different target**, because capabilities
differ — and not monotonically ("better/worse"), but as genuinely different sets.

| capability | CLI interactive (TUI) | CLI headless `-p` | VS Code / web host |
| --- | --- | --- | --- |
| `human_approval` | ✅ native (prompt / plan-mode) | ❌ no human → **fail** or external channel | ✅ |
| `render_contract` (chart/kpi) | ⚠️ degrade (terminal markdown) | ⚠️ realize-via (html file) / degrade | ✅ native (components) |
| `structured_output_capture` (trace, programmatic render) | ❌ not captured | ✅ native (stream-json) | ✅ |
| `subagent_dispatch` (per-step tier) | ✅ | ✅ | ✅ |
| `scheduler` / `event_bus` (triggers) | ❌ | ❌ | ❌ (all need external) |

Note headless *loses* `human_approval` but *gains* `structured_output_capture` — that is exactly
why they must be two targets, not two flags on one.

## 2. Four resolution outcomes per capability

At dispatch, every capability the IR requires (from `required_capabilities`, `guardrails`,
`effect`, `trigger`, `realization_kind`, `llm_calls[].tier`) resolves to exactly one of:

| outcome | meaning | example |
| --- | --- | --- |
| **native** | target provides it directly | interactive `human_approval` |
| **realize-via** | no native, but mappable onto a borrowed equivalent | `per_step_tier` → subagents; `render_contract` → html renderer; `scheduled` → external cron |
| **degrade(warn)** | no faithful support; an acceptable lossy fallback exists — **must be logged** | `render_contract` → markdown |
| **fail** | no support, no acceptable degrade, and the requirement is load-bearing | headless `human_approval`; `blast_radius` under coarse binding |

Historical note: v0.1's per-step-tier "collapse to one model" was a **silent degrade**; v0.2 turned
it into **realize-via** (subagents). The four outcomes were always there — this model names them.

## 3. Criticality decides fail-vs-degrade

Each capability carries a **criticality**, generalizing the existing `guardrails.locked/overridable`
distinction to *all* capabilities:

- **safety-critical** (maps to `locked` guardrails: `human_approval`, `write_authz`, `blast_radius`)
  → if unsupported, **must fail — never silently degrade**.
- **best-effort / presentational** (e.g. `render_contract`) → degrade + warn is acceptable.
- For non-safety capabilities, the **profile may override** the default fail-or-degrade choice
  (mirrors `overridable`). Safety-critical criticality is not overridable downward.

## 4. Resolution algorithm + report

```
for each required capability C in the resolved IR:
    p = target_profile.lookup(C)
    outcome[C] = native | realize-via | degrade | fail   (per §2, gated by C.criticality per §3)
if any outcome == fail (load-bearing):
    abort dispatch with a loud error naming C and the target
else:
    emit the realized agent + a capability-resolution report
```

The dispatch output is therefore **either** a loud failure naming the unsupported load-bearing
capability + target, **or** the realized agent **plus a resolution report** listing every
capability and its outcome. **Degradation is never silent** — it always appears in the report
(the "no silent caps" rule).

## 5. Why this is the core mechanism

- It **subsumes every wall-hit**: #1 per-step tier, #2 render, #3 guardrails, #5 triggers are each
  just "capability C's resolution on target T." Patching them individually was the symptom; this is
  the mechanism.
- It makes **portability checkable before running** (the Hub premise): a profile advertises its
  `required_capabilities`; any target can be scored **full / degraded / incompatible** ahead of
  time. The `engine × mode` granularity makes that answer precise (same profile: full on VS Code,
  degraded on headless CLI, fail on a no-FS sandbox).
- It keeps the front/back-end split honest: the **IR names capabilities + criticality only**, never
  mechanisms (`html`, `subagent`, `cron` never appear in the IR). Legalization to a target's
  mechanisms is entirely the back-end's job.

## 6. `provided_by` — who supplies the capability

A capability's resolution has a second axis besides the outcome: **who provides it**. This is what
separates borrowed table-stakes from the moat.

| `provided_by` | meaning | examples |
| --- | --- | --- |
| `runtime` (borrow) | the target (or a borrowed external) supplies it | `subagent_dispatch`, `scheduler`, `event_bus`, `human_approval`, `write_authz`, `render:html` |
| `warble` (built-in policy) | **only Warble can compute it** — over MDL/Context | `blast_radius` (MDL lineage) |
| `none` | nobody supplies it here → degrade or fail | — |

A capability entry may also declare `requires:` (a precondition on the *binding*, not the runtime),
e.g. `blast_radius requires: fine_grained_binding` → under coarse binding it loud-fails regardless of
runtime. **As of Phase 2 that precondition is satisfiable:** the MDL adapter (`bindings/mdl-context`)
provides fine-grained binding — metric/grain-level resolution + a lineage DAG — so `blast_radius` is
computable (read path) on any bound wren project. The `requires: fine_grained_binding` loud-fail now
only fires for a target that binds *coarsely* (no `ContextLoader`), not for the MDL path. This makes
visible, in one place, which capabilities are **borrowed** (don't build) vs the **one you must
build** (`blast_radius`) — the same line as vision §3 (borrowed table-stakes = pass; your
differentiator = the moat).

## 7. How the wall-hits map in

| wall-hit | capability | provided_by | typical resolution by target |
| --- | --- | --- | --- |
| #1 per-step tier | `llm:per_step_tier` | runtime | native (programmatic per-call model) · realize-via (subagents, CLI) · degrade→one model (warn) |
| #1b per-step **provider** (hybrid) | `llm:per_step_provider` | **warble** (executor/tool) · runtime (model runtimes) | realize-via (SDK: staged-executor / in-process-mcp · file target: skill-shell) — see §7.2 |
| #2 render | `render_contract` | runtime | native (UI host) · realize-via (html renderer) · degrade→markdown (warn) · fail (no surface) |
| #3 guardrail (mechanical) | `human_approval`, `write_authz` | runtime (borrow) | native (interactive) · realize-via (approval channel) · **fail** (headless, safety-critical) |
| #3 guardrail (semantic) | `blast_radius` | **warble** | native (Warble policy over MDL lineage) · **fail** under coarse binding (`requires: fine_grained_binding`) |
| #5 triggers | `scheduler`, `event_bus` | runtime (borrow external) | realize-via (cron / pub-sub) · fail (no mechanism). Wiring (`emits`↔`trigger`) is Warble-derived; transport borrowed. |

### 7.1 `blast_radius` — the one capability Warble must build

> As-built implementation (types, graph construction, the read-only query, worked example, and
> current limitations): [`blast-radius.md`](./blast-radius.md). This section is the design/rationale.

`blast_radius` = the downstream impact set of a **mutating** action, computed over the semantic
lineage DAG (`raw → models → relationships → metrics → views → dashboards/queries`). Changing a node
→ its transitive downstream closure is the blast radius. Impact severities:
- **structural** — a column dropped/renamed breaks downstream queries (loud);
- **semantic** — a metric definition change silently shifts the numbers for every consumer (dangerous);
- **compatibility** — type/grain mismatch.

Used as a guardrail, it is computed at **dry-run** (read-only analysis) and gates the **apply**
(write): `blast_radius_limit` → block or escalate to `human_approval` when the radius exceeds a
threshold or touches a protected/certified asset; empty radius (e.g. editing a description) →
auto-allow. Analysis (read) gates action (write); `trigger ⊥ guardrail` (auto-trigger ≠ auto-apply).

Why it is `provided_by: warble` and not borrowed: an OS sandbox / generic runtime sees only "a file
was written" — it cannot know that file defines a metric N dashboards depend on. `blast_radius =
f(MDL lineage)`, computable only by something that reads the semantic graph. This is the data-native
wedge showing up in **enforcement**, not just in component declarations (vision §12.2, "sandbox ≠
guardrail"). It needs fine-grained MDL binding — **landed in Phase 2** via the `ContextLoader` MDL
adapter, which self-builds the lineage DAG and lets core compute the downstream closure + severity
(`ir-schema.md` §v0.3 fine-grained binding). Phase 2 delivers the **read path** (dry-run analysis);
gating a *mutating* apply on the radius is Phase 4. Under a coarse binding (no `ContextLoader`) the
capability model still loud-fails it (safety-critical, never silent).

### 7.2 `llm:per_step_provider` — hybrid (cloud + local in one run)

**What it is:** different steps of one component run on different *providers* within a single dispatch
— e.g. the `cheap` step on a local open-source model (ollama) and the `strong` step on cloud Claude.
This is **distinct from `llm:per_step_tier`**: that is same-provider *model* selection (which Claude
model per step), and a target can realize it while still being unable to do hybrid. The Agent SDK is the
proof — `agents[].model` varies the Claude model per step (`per_step_tier` = native) but **loud-fails on
a non-Claude model id**, so it does not by itself grant `per_step_provider`. The two must be separate
capabilities or "supports hybrid?" is mis-reported.

**Triggered by the binding, not the IR (so it is checked at dispatch, not resolve).** The IR carries
only tiers; whether hybrid is needed depends on the layer-3 `--models-config` binding (a step bound to a
non-Anthropic `provider`). So `per_step_provider` is **not** an IR-static `required_capability` and is
not in `impliedCapabilities`. Instead each back-end applies a **binding-time gate**: once the models
config is resolved, if any step's provider is non-native for the target, the target's profile MUST
realize `llm:per_step_provider`, else loud-fail (naming the step, provider, and target). All-cloud
bindings — including the shorthand string form `cheap: <model>`, whose provider defaults to `anthropic`
and which may name-route through a proxy — never trip the gate.

**How each target declares support** (this *is* the "does this dispatcher support hybrid?" answer —
read it in the target's capability profile, or on a loud-fail):

| target | outcome | via |
| --- | --- | --- |
| `claude-agent-sdk:local` | realize-via | `staged-executor` (Warble drives the steps) or `in-process-mcp` (an orchestrator `query()` calls a `dispatch_step` tool), selected by `WARBLE_HYBRID_MODE` |
| `claude-code:headless` / `:interactive` (file target) | realize-via | `skill-shell` — dispatch emits a local-inference script (`scripts/<step>.sh` → `local_infer.py`, OpenAI-compat) that the driver runs via Bash for the LOCAL step; cloud steps stay the driver's own `wren` work at its (strong) tier. A cleaner **second** realization (`mcp-server`, an out-of-process MCP server via `.mcp.json`) is documented below but not yet built |

Both realizations are live-proven on `answer_query` (local `resolve_intent` on ollama qwen2.5 + cloud
`generate_sql` on Opus, correct result). The `skill-shell` path carries a **guardrail trade-off**: the
driver must be allowed to run `bash` (to invoke the local-inference wrapper), a wider trusted-command
surface than the all-cloud read-only agent. The `mcp-server`/`in-process-mcp` realizations avoid this —
an MCP tool is gated separately from the Bash allowlist — which is the main reason to prefer an MCP
realization where the read-only boundary matters.

**`provided_by`:** split — Warble supplies the *executor/tool* (the per-step sequencing + provider
routing + `produces`→`consumes` marshaling), while the *model runtimes* (the Claude SDK loop, the local
ollama endpoint) and the tool/MCP mechanism are **borrowed**. So Warble's own code is a thin router, not
an inference or orchestration engine — and if a runtime ever spans providers per-step natively, this
realization should retire in favor of borrowing it (vision §3.5: own the callee + interface, not the
caller's loop).

## 8. To land later (implementation)

- **Target capability profile format** (declarative: engine×mode → per-capability native/realize-via/degrade, with `provided_by` and any `requires:` binding preconditions).
- **`criticality` field** on capabilities (safety-critical vs best-effort; profile override for non-safety).
- **Resolution pass in `warble dispatch`** producing the report + loud-fail; a `--target` selects the profile (e.g. `claude-code:headless`, `claude-code:interactive`).
- Rewrite the §v0.2 / §v0.3 back-end notes as "capability C resolved on target T" rather than bespoke logic.
