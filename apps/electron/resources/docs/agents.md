# Agents

Agents are reusable, isolated workers that the main conversation can delegate to for bounded side work. Each Agent has its own instructions, optional tool allowlist, and optional model override. It receives the delegated task rather than the complete main-session history, so the parent should give it the context needed to finish its job.

## Built-in compact agent

`compact` is a built-in Agent that summarizes the active conversation to reduce context usage while preserving the goal, decisions, constraints, open work, and relevant paths. Use the **Compact** button in chat to run it. It is always available and continues to use the native context-compaction flow. Its display name, description, and compaction instructions can be customized from **Automations -> Agents**; the built-in behavior itself cannot be replaced.

## Custom agents

Custom Agents are stored at the root of a workspace:

```text
<workspace>/agents.json
```

```json
{
  "version": 1,
  "agents": [
    {
      "id": "code-review",
      "name": "Code reviewer",
      "description": "Review a focused change for bugs, regressions, and missing tests.",
      "prompt": "Inspect the requested change independently. Report findings ordered by severity, cite relevant files, and propose focused fixes.",
      "tools": ["Read", "Grep", "Glob"]
    }
  ]
}
```

| Field | Description |
|---|---|
| `id` | Required lowercase identifier using letters, digits, and hyphens. `compact` is reserved. |
| `name` | Human-readable name shown in the Agents manager. |
| `description` | Tells the main Agent when to delegate to this worker. |
| `prompt` | Independent instructions and expected output for the worker. |
| `tools` | Optional tool allowlist. Omit only when inheriting the parent tool set is intended. |
| `model` | Optional model alias or model ID. Omit to inherit the main session model. |

## Designing a useful agent

Give each Agent a single, recognizable responsibility. A good description answers “when should I use this?”, while the prompt states what it should examine, important constraints, and the deliverable it must return. Grant only the tools required for that job. For instance, a code-review Agent often needs `Read`, `Grep`, and `Glob`; it does not need write or shell access unless it is meant to verify tests.

Use custom Agents for tasks that benefit from independent exploration or reasoning. Use `call_llm` for a single tool-free completion, and keep simple work in the main conversation when delegation would add overhead.

## Managing agents

Open **Automations -> Agents** to view the built-in compact Agent and workspace Agents. The manager provides manual configuration and an AI-assisted configuration entry point. Workspace Agents update without restarting the app; a new main-session turn loads the current definitions.
