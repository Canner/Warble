# First harness: summarize supplied text

The whole authored harness is `profile.yml`: one inline, read-only behavior with a short prompt.
No semantic context, fabricated project or separate prompt file is required.

From the repository root:

```bash
warble check examples/first-harness --target claude-code:headless
warble preview examples/first-harness --target claude-code:headless
warble build examples/first-harness --target claude-code:headless --out agent
```

Preview shows exact native instructions with source information. Build requires a new output
directory. These commands compile and emit offline; they do not run a model. Inspect the generated agent,
profile instructions and `RUN.md`. No semantic-context/tool-result preamble is injected.
The shorthand fixes a one-shot analytical skill, one cheap-tier step, a locked read-only guardrail,
LLM capability and no output effects. Native Claude Code exposes Read; the prompt's request to
avoid tools is guidance, not a zero-tool permission guarantee.

See [Your first profile](../../docs/site/docs/getting-started/first-profile.md) for extraction into
a reusable component, equivalent full syntax, longer file prompts and adding real prepared context.
Other unsupported context-free targets/shapes refuse before emission. Use matching IR 0.9 readers;
recompile old 0.8 IR. No live answer quality is claimed.
