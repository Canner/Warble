---
title: AI resources
description: "How coding agents can consume these docs — a planned build-time llms.txt index/export, per-page raw Markdown today, and where the underlying contracts live."
---

This site is built with [Docusaurus](https://docusaurus.io/). If you're pointing a coding agent at
Warble (to author a profile, write a component, or
interpret a `blast_radius` gate result), here's what's actually available today and what's planned.

## Per-page Markdown

Every page on this site is authored in plain Markdown, and the source files are readable directly
from the repo (`docs/site/docs/...`) without any rendering step. For a single page — say, the
[IR schema](/reference/ir-schema) — that raw Markdown is the fastest way to hand a coding agent the
exact contract text.

## Planned: a build-time `llms.txt` index

Machine-readable exports for the whole site (an `llms.txt` page index, plus a concatenated
full-text export) are **not live yet**. The plan is to generate them at build time via a prebuild
step that runs before the site build and emits the index/export alongside it. Wiring this generator
into Warble's own build is a **planned follow-up**, not a shipped feature — don't assume
`/llms.txt` or a full-text export resolve on this site yet.

## Where the actual contracts live

Until the generator lands, the source of truth for what Warble's IR, profile schema, and
capability model actually guarantee is the **Reference** section: the
[IR schema](/reference/ir-schema), the [profile schema](/reference/profile-schema), the
[capability model](/reference/capability-model), and the [glossary](/reference/glossary) for the
vocabulary this site uses consistently (component, IR, wall-hit, tier, and so on). An agent
authoring against Warble should treat those pages, not this one, as the spec — and can fetch any of
them as raw Markdown today, per-page, exactly as described above.
