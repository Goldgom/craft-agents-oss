---
name: agent-authoring
description: Design reusable, isolated subagents with a narrow purpose, independent instructions, and least-privilege tools.
---

# Agent authoring

Use this skill to create or edit `agents.json`. A custom agent is an independent worker the main conversation can delegate bounded side work to; it is not a replacement for the main conversation.

Each agent needs a stable lowercase-hyphenated `id`, a clear name, a description explaining when the main agent should use it, and an independent `prompt`. Optional `tools` are an allowlist; omit it only when inheriting the parent set is deliberate. `model` is optional and should normally inherit unless the work has a clear cost or capability requirement.

Give agents one job: for example, investigate a codebase, review a patch, or summarize supplied material. Specify the expected deliverable and important constraints in the prompt. Avoid vague “do anything” agents and avoid tools unrelated to that job.

The `compact` id is reserved for the built-in context-compaction agent. Do not add or replace it in `agents.json`.

After editing, state the delegation use case, the independent context boundary, and the granted tool set.
