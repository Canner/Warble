---
title: Quickstart
description: "Compile a text-summary harness and inspect its native agent files without a database or model call."
---

This tutorial uses `examples/first-harness`: one local behavior that summarizes text supplied by
the user. Compile and dispatch are offline and do not call a model. Running the emitted agent is
a separate, optional step.

Install the binary using [Installation](/getting-started/installation). The examples are source
files, not part of the installed binary, so get a checkout first:

```bash
git clone https://github.com/Canner/Warble.git
cd Warble
```

Use a CLI version compatible with this checkout. Changes described in these source docs may
require building the checkout rather than using an older installed release.

## 1. Read the behavior

Open `examples/first-harness/profile.yml`. It asks the agent to
summarize supplied text in one sentence. The component does not query a semantic layer or render
a dashboard.

The profile contains the behavior and prompt inline. It declares no context, and the IR records
that absence explicitly. The actual text arrives in the user's request. A component that declares
semantic requirements cannot omit its binding.

## 2. Check, preview and build native files

From the repository root:

```bash
warble check examples/first-harness --target claude-code:headless
warble preview examples/first-harness --target claude-code:headless
warble build examples/first-harness --target claude-code:headless --out agent
```

The inline behavior avoids network library resolution. These commands manage intermediate IR
in a temporary directory; you do not need to create or edit it. Preview shows the exact native
instruction files, their author sources and generated permissions. Build requires a new output
directory and writes native configuration. None of these commands starts a model.

Use the same target, model and slot selections when previewing and building. Vendor instructions,
the user request, conversation history and tool results arrive later at runtime. For the full
options and integration path, see [author commands](/reference/cli#author-commands-check-preview-build).

## 3. Inspect the output

Read `agent/.claude/agents/summarize_text.md`, `agent/capability-report.json` and `agent/RUN.md`.
Check the emitted instructions and supported capabilities before starting the native agent.
The report describes target preparation; it is not evidence of a completed model run.
This context-free agent contains no semantic-context or tool-result preamble. Native Claude Code
headless/interactive targets support this bounded read-only shape; unsupported targets/shapes
refuse before emitting files. Use matching IR 0.9 readers and recompile saved 0.8 IR.

## 4. Optionally run the native agent

With Claude Code installed and authenticated, run from the output directory:

```bash
(cd agent && claude -p "Summarize: We shipped the update on Monday. Two customers reported faster loading." --agent summarize_text)
```

This step starts the native agent and may consume your model allowance. The example needs no
`wren` CLI or database. It bundles no recorded model answer; inspect the response yourself.
"One sentence" is a prompt instruction, not a deterministic length validator.

## 5. Change it

Change the prompt to request two bullet points, compile again and dispatch to a fresh output
directory. Inspect the changed native instructions. No component schema change is needed.

[Your first profile](/getting-started/first-profile) shows every source file. The older
`examples/mini-agent` is an authoring-schema smoke fixture, not this tutorial.

For a data-connected dashboard, see `examples/render-demo` and
[Rendering](/guides/rendering); its actual run additionally needs the data tools and a queryable
project described in its generated `RUN.md`.
