---
title: Introduction
description: "Author an agent's harness: reusable instructions, tool requirements and constraints, materialized for a supported runtime."
slug: /
---

**Warble helps you write and reuse an agent's harness.** Keep its instructions, behaviors,
tool requirements and constraints in reviewable files, then materialize them for the runtime
you choose. Start with one behavior; reuse components when you need them.

Your prompts are part of the authored product. Warble checks and combines them with a profile
and a context binding when the behavior needs one. The intermediate representation (IR) lets different back-ends
consume that source; you do not need to learn its schema to write your first harness.

## What you do

1. Write the instructions for a behavior.
2. Mount it in a profile and declare the context and capabilities it needs.
3. Compile and emit native artifacts for a supported target.
4. Inspect those artifacts and run the native agent yourself.

The first example summarizes user-supplied text, with no database or data tools. Data agents
remain the main use case: components can require a semantic context and data access supplied by
your host. Text-only behaviors can start in one file with no context binding; declaring semantic
requirements makes an explicit, verifiable binding necessary.

## Who owns what

| Owner | Responsibility |
| --- | --- |
| Harness author | Instructions, reusable behaviors, tool requirements and constraints |
| Warble | Compile-time checks, prompt composition, target capability checks and native materialization |
| CLI coding agent | Conversation, model reasoning and its own agent loop |
| Runtime or embedding host | Credentials, actual tool access, sandbox and supported enforcement |

CLI file targets produce instructions and settings. They do not supply a general workflow runner.
"Try again if the query fails" can be an instruction; "never execute more than three queries"
requires an actual counter and enforcement mechanism. Unsupported safety-critical and unknown capabilities fail before executable emission.
Best-effort capabilities may degrade when the target explicitly allows it, with that outcome
recorded in the capability report; listing a capability does not override its criticality.

Existing SDK/local back-ends have their own bounded execution contracts. Switching targets does
not promise identical behavior or identical enforcement. A compiled profile or emitted file
proves preparation, not successful model execution.

## When Warble helps

- You want to review and version the instructions and requirements of your agent.
- You want to reuse a behavior without copying its prompts into every harness.
- You want target-specific artifacts and visible compatibility failures.

If you need arbitrary loops, scheduling or durable workflow recovery, put that control in your
own host or tools. Warble does not add a new stateful runner for CLI targets.

## Start here

- [Quickstart](/getting-started/quickstart) — compile and inspect the smallest introductory example.
- [Your first profile](/getting-started/first-profile) — write that example yourself.
- [Settings and guarantees](/reference/profile-schema#what-an-authored-setting-guarantees) — instructions, enforcement and metadata.
- [How Warble works](/concepts/how-warble-works) — the compiler and target boundary, when you need the details.
