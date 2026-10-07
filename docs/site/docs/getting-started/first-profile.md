---
title: Your first profile
description: "Write a single-file harness, extract a reusable component, and add real context only when needed."
---

Start with one file. This harness summarizes text supplied by the user; it does not need a database
or context binding. The bundled source is `examples/first-harness/profile.yml`.

## The daily author workflow

After writing `profile.yml`, run these from the repository root:

```bash
warble check examples/first-harness --target claude-code:headless
warble preview examples/first-harness --target claude-code:headless
warble build examples/first-harness --target claude-code:headless --out agent
```

No intermediate IR path is needed. Preview names the contributing files/fields and shows the
actual native instruction files, permissions and capability resolution. A mount's brief replaces
the component brief; profile instructions are appended before the effective brief. Slot selections
are labeled separately from unselected variants. Use identical `--target`, model and `--slot`
options for preview and build. See [author commands](/reference/cli#author-commands-check-preview-build).

Build requires a new output directory. Read its `RUN.md`; only then, when you intend to start a
model, launch the native CLI yourself. For this example:

```bash
(cd agent && claude -p "Summarize: The update shipped Monday. Loading is faster." --agent summarize_text)
```

The preview covers static Warble files, not vendor system instructions, future user input, tool
results or conversation history. Authored prompts are shown verbatim; keep credentials out of
those files. The lower-level compile examples below remain useful for comparing extraction results.

## 1. Write a behavior

Create a folder named `first-harness` and put this file inside it:

```yaml title="profile.yml"
profile: text-helper
components:
  - id: summarize_text
    description: Summarize text supplied by the user.
    prompt: |
      Summarize the text supplied in the user's request in one short sentence.
      Use only that text; do not look up information or call tools.
      If no text was supplied, ask the user to provide it.
      Return plain text.
```

`id` identifies the behavior; `prompt` contains its instructions. The optional `description`
helps a user or agent choose it. There is no hidden semantic project and no generated data-context
or tool-result preamble.

The shorthand has conservative, fixed defaults: analytical skill, one step named `respond`,
`cheap` model tier, one-shot trigger, locked `read_only_execution`, and no output effect.
The native Claude Code file targets expose `Read`, with no data or write tools for this shape.
"Do not call tools" and "one short sentence" are prompt instructions, not enforced tool absence
or a sentence-count validator. You can set `tier` explicitly; the target binds it to a model.
Only `id`, `prompt`, `description` and `tier` are accepted by this shorthand. To declare additional
capabilities or effects, use the full component shape below so its requirements stay explicit.

## 2. Compile and inspect

From the directory containing your folder:

```bash
warble compile first-harness -o ir.json
warble dispatch ir.json --target claude-code:headless --out agent
```

Inline-only and locally resolved projects compile offline without fetching the Hub. The dispatcher
writes native files; neither command starts a model. Inspect `.claude/agents/summarize_text.md`,
`.claude/CLAUDE.md`, `capability-report.json` and `RUN.md` under `agent/`.
The IR records `context_binding: null`, not a fabricated external locator or checked schema.

With Claude Code installed and authenticated, you can run the native agent yourself:

```bash
(cd agent && claude -p "Summarize: We shipped the update on Monday. Two customers reported faster loading." --agent summarize_text)
```

This optional step uses your model allowance. No live model result is claimed by this tutorial.
Native `claude-code:interactive` emission also supports this simple shape. Other targets and more
complex context-free behaviors currently refuse before output; no workflow runner was added.

## 3. Extract a reusable component

When the behavior deserves reuse, replace your profile with:

```yaml title="extracted-profile.yml"
profile: text-helper
components:
  - use: summarize_text
```

Move the same behavior into `components/summarize_text/component.yml`:

```yaml title="component.yml"
id: summarize_text
description: Summarize text supplied by the user.
prompt: |
  Summarize the text supplied in the user's request in one short sentence.
  Use only that text; do not look up information or call tools.
  If no text was supplied, ask the user to provide it.
  Return plain text.
```

Compile and dispatch again to a fresh output directory. Inline and extracted forms produce the
same IR, instructions, tool permissions and output intent. The shorthand is authoring convenience,
not a second execution language. Existing `use` mounts still resolve against explicit local and
Hub sources with their normal precedence and ambiguity checks.

## 4. Expand only when the behavior needs more fields

This full `components/summarize_text/component.yml` is equivalent to the shorthand above:

```yaml title="full-component.yml"
id: summarize_text
verb: summarize_text
description: Summarize text supplied by the user.
type: analytical
realization_kind: skill
binding_mode: runtime_selected
llm_steps:
  - name: respond
    tier: cheap
    prompt: |
      Summarize the text supplied in the user's request in one short sentence.
      Use only that text; do not look up information or call tools.
      If no text was supplied, ask the user to provide it.
      Return plain text.
trigger: { kind: one_shot }
guardrails:
  - { name: read_only_execution, locked: true }
required_capabilities: [llm:cheap]
effect:
  render_blocks: []
  outcome: { kind: none }
```

A full component can also live directly in the profile's `components` list. A step may contain
`prompt` or `prompt_ref`, never both. For a longer prompt, move its text to `steps/respond.md` and
replace the inline `prompt` block with `prompt_ref: steps/respond.md`. File references stay relative
to the declaring component directory (or the profile directory for an inline definition), and
cannot escape it. Do not combine an inline definition with `use` in one entry or mount an ID twice.

## 5. Add a real context when needed

A behavior needing schema facts must declare and bind them. In the full component above, add:

```yaml
context_precondition:
  - predicate: has_metric
```

Compilation without a binding now fails, naming `summarize_text` and `has_metric`. Likewise, context
requirements and `{{project}}` / `{{project_name}}` require a binding. Omission never makes those
checks pass. A `source: runtime-injected` parameter does not itself require a binding; context-free
native file targets currently reject it before output because they do not supply runtime parameter
values.

For a reproducible offline example, use the checked-in host projection for the bundled Jaffle Shop
example. From the Warble checkout, with your tutorial folder at `examples/first-harness`:

```bash
mkdir -p examples/first-harness/context
cp examples/demo-agent/context/context.json examples/first-harness/context/context.json
```

This is the sample project's prepared snapshot, not invented facts to satisfy a predicate. For your
own data, have its host produce a current prepared-context document; Warble does not read a semantic
format or discover a database automatically.

Use this profile and binding:

```yaml title="context-profile.yml"
profile: text-helper
context:
  project: context/binding.yml
components:
  - use: summarize_text
```

```yaml title="context/binding.yml"
kind: prepared
project: ../jaffle-wren
document: context/context.json
```

Recompile. The predicate is now evaluated against that snapshot, and the IR carries the actual
resolved metrics. This demonstrates adding the dependency; it does not itself add a query tool or
turn the summarizer into a data analyst. Update the prompt and declare required data capabilities
when changing the behavior, and verify that your chosen target supports them.

## Compatibility and limits

IR 0.9 explicitly represents absent context. Upgrade the compiler and target readers together,
then recompile saved 0.8 IR; readers reject incompatible versions. Existing explicit-context
profiles and extracted full components keep their behavior. `examples/mini-agent` remains a schema
smoke fixture, separate from this introductory harness.

Non-null `components[].config` remains a compile error; use documented mount fields such as `bind`
for intentional parameter overrides. See [settings and guarantees](/reference/profile-schema#what-an-authored-setting-guarantees)
and [binding context](/guides/binding-context).
