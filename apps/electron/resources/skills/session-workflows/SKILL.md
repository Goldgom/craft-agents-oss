---
name: session-workflows
description: Manage TokenBird session metadata, task-board entries, background work, cross-session communication, and automation handoffs.
---

# Session workflows

Use `get_session_info` for detailed session state. Use filtered, paginated `list_sessions` for discovery; do not request a high limit just to scan everything.

`set_session_labels` replaces all labels. Boolean labels use the ID; valued labels use `id::value` and must match the configured type. `set_session_status` may move work to review, but closing a task as done or cancelled remains the user's decision.

Use `create_task` only to capture work on the board. It creates a todo item and orchestrator session but does not run it. Use `spawn_session` or continue locally when execution should begin now.

Use `list_background_tasks` as the source of truth for running, finished, or orphaned agents across turns. Never infer status from an old subprocess. A queued `send_agent_message` acknowledgement means the target has not read it yet; wait for a response or query state.

`archive_session` archives or restores another idle session; it does not delete data and cannot target the current session.

Labels and statuses can trigger automations. A safe handoff ends at a review status and lets the user perform final closure.
