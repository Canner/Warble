---
title: Tiers & model binding
description: "Tier is an abstract model class (strong / cheap) carried in the IR; the dispatcher binds each tier to a concrete model and provider only at dispatch time, via a `--models-config` binding."
---

## Tier is a class, not a model name

A component's `llm_steps` each declare a **tier** — `strong` or `cheap` by convention, though the
vocabulary is open and a component may define its own names. A tier is an abstract cost/capability
class, never a model id: `plan_dashboard` runs at `strong`, `compose_layout` at `cheap`, and neither
step's prompt or profile ever names `opus` or `haiku`. That name-free-ness is deliberate — the IR
would otherwise hard-wire a specific model into behavior that has nothing to do with which model runs
it.

Per-step tier is **git-static** — it's authored in the component and travels through compile
unchanged into the IR's `llm_calls[].tier`. What *is* runtime-injected is the next layer down: which
concrete model, and which provider, each tier name resolves to. That resolution happens at
**dispatch**, not compile, via a `--models-config` binding — see the
[tier→model binding spec](/reference/binding-spec) for the full YAML shape.

## Why the split matters

Because the concrete model is a dispatch-time binding rather than IR content, the same compiled IR
can be re-dispatched against a different `--models-config` with no recompile — swap `strong` from
Opus to Sonnet, or point `cheap` at a local model, and nothing about the profile, component, or
compiled behavior changes. The eval loop has two distinct modes: `warble eval run --models
opus,haiku` is a **flat** sweep, applying each listed model to every tier for one whole-run pass.
To evaluate a differentiated tier→model mapping, use `--models-config` or all of `--strong`,
`--cheap`, and `--orchestrator` with `--backend claude-agent-sdk`; that injected mapping runs one
pass and bypasses the flat `--models` sweep. See [Evaluating a profile](/guides/evaluating) for the
backend restriction and dispatch-time alternative for file targets.

## Per-step heterogeneity, realized per target

A component with steps at different tiers needs the *runtime* to actually switch models mid-run, and
each target realizes that differently:

| Target | How per-step tier heterogeneity is realized |
| --- | --- |
| `claude-code:headless` (file target) | One **subagent** per divergent-tier step, each with its own `model:` frontmatter; the driver marshals `consumes`/`produces` between them. |
| `claude-agent-sdk:local` (in-loop) | A native in-loop model switch — `agents[].model` varies per step inside the same `query()` session. |

The file target resolves this `realize-via` — a static agent file has only one `model:`
frontmatter, so it borrows the subagent mechanism to get a second one. The Agent SDK target
resolves it `native` — `agents[].model` lets it switch model in-loop directly, per step, with no
borrowed mechanism needed. See
[Capabilities & guardrails](/concepts/capabilities-and-guardrails) for how that resolution is scored.

:::tip
This is also what makes **hybrid** local + cloud inference possible: a `--models-config` binding can
route the `cheap` tier to a local OpenAI-compatible endpoint and `strong` to cloud Claude in the same
run, with the IR none the wiser. See [Hybrid inference](/guides/hybrid-inference) for a worked
example, and [Components](/concepts/components) for where tiers are declared in the first place.
:::
