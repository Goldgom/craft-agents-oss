---
name: llm-delegation
description: Use call_llm for parallel, isolated, tool-free model processing, structured extraction, and context-efficient batch work.
---

# LLM delegation

Read `~/.tokenbird/docs/llm-tool.md` before advanced calls or when parameter details are uncertain.

Use `call_llm` for independent single-completion work that needs no tools or conversation history: batch summarization/classification, schema-constrained extraction, low-cost processing, large attachment isolation, or focused deeper reasoning.

Pass file paths through attachments instead of copying large contents into the main context. Use `outputSchema` when the caller needs reliable structured JSON. Independent calls may run in parallel.

Do not use it for trivial work, for work that depends on the current conversation, or when the subtask needs file, shell, browser, or source tools. If enabled and available, a tool-using Agent/Task subagent is the appropriate mechanism for the latter.
