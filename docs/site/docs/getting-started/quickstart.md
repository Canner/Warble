---
title: Quickstart
description: "Compile the bundled render-demo profile to IR, dispatch it to the Claude Code CLI target, and render a captured result — end to end in about five minutes."
---

This walks the full pipeline — profile → IR → agent → render — on the `examples/render-demo`
project that ships in the Warble repo, not with the `warble` binary itself. If you installed
`warble` from a released binary you won't have `examples/` yet — step 1 below gets it. Compiling
and dispatching render-demo don't require a wren project of your own — it already binds the
bundled `jaffle-wren` project — but actually running the emitted agent (step 5) does query that
data through `wren`.

If you haven't installed `warble` yet, see [Installation](/getting-started/installation) first.

**1. Get the example project**

You need the `examples/` directory from the Warble repo. Either clone the repo:

```bash
git clone https://github.com/Canner/Warble.git
cd Warble
```

or, if you'd rather not clone the whole history, download and extract the `v0.1.0` release's
source archive:

```bash
curl -LsSf -o source.tar.gz https://github.com/Canner/Warble/releases/download/v0.1.0/source.tar.gz
tar -xf source.tar.gz
cd warble-cli-0.1.0
```

The remaining steps assume your shell is in that directory, so `examples/render-demo` resolves.

**2. Compile the profile to IR**

```bash
warble compile examples/render-demo -o ir.json
```

This is the front-end: it parses `profile.yml`, the mounted `dashboard` component, and the
context binding, merges defaults with overrides, validates the result, and emits `ir.json` —
the language-neutral IR. Every back-end consumes this same file.

**3. Dispatch the IR to a target**

```bash
warble dispatch ir.json --target claude-code:headless --out agent
```

This is the back-end step: it legalizes the IR onto the Claude Code CLI target and writes native
agent files (plus a generated `RUN.md`) into `agent/`.

**4. Inspect the capability manifest**

```bash
warble manifest ir.json
```

Prints the capability manifest for this IR to stdout — what the compiled behavior needs from
whatever runtime it's dispatched to (LLM tiers, guardrails, borrowed actions, and so on).

**5. Run the emitted agent**

Running the agent for real needs the `wren` CLI pointed at a queryable wren project — the
generated `agent/RUN.md` spells out the exact invocation for what got dispatched. Follow it to
get a captured result envelope (e.g. `result.json`).

**6. Render the result**

```bash
warble render result.json --out dashboard.html
```

Takes the captured envelope from the run and deterministically renders it to a static HTML
dashboard at `dashboard.html` — no LLM call involved in this step.

## What you just produced

| Command | Input | Output |
| --- | --- | --- |
| `warble compile` | profile + components + context | `ir.json` — the language-neutral IR |
| `warble dispatch` | `ir.json` | native Claude Code agent files + `RUN.md` |
| `warble manifest` | `ir.json` | the capability manifest (stdout) |
| `warble render` | a captured result envelope | a static HTML dashboard |

## Next steps

- **[Your first profile](/getting-started/first-profile)** — Author the smallest possible profile from scratch instead of using the bundled example.
- **[How Warble works](/concepts/how-warble-works)** — The mental model behind these four commands: front-end, IR, back-end, and why the contract is the product.
