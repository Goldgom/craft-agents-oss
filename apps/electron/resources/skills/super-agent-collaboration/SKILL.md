---
name: super-agent-collaboration
description: Coordinate authorized work inside an active TokenBird Super Agent team using registered collaboration tools, durable plans and shared evidence. Applies to main, background planning, dispatch and worker nodes within their assigned roles.
---

# Super Agent collaboration

Use registered `mcp__session__super_agent_*` tools with ordinary schema arguments. Tool receipts identify committed actions; queueing and a normal model turn do not prove completion. Follow the current node role, user goal revision and actual host permissions.

Read only the reference needed for your current role or operation:

- Interaction: [user intent and delivery](references/interaction.md).
- Background planner: [original requests, goals and plans](references/planning.md).
- Dispatch coordinator: [dispatch and acceptance](references/orchestration.md).
- Worker: [shared evidence, checkpoints, resources and scripts](references/worker.md).
- Failed calls or retries: [receipts and recovery](references/recovery.md).

For roleTopologyVersion=2, communication is main ↔ planner ↔ dispatcher ↔ owned workers. Never broadcast, contact siblings or skip a role, including in full control. Reports go to the host-selected adjacent inbox; sourceReportIds preserve evidence provenance. Legacy teams retain their old protocol until host migration.

Keep task handoffs concise: objective, applicable user constraints, input paths or board IDs, outputs and acceptance checks. Do not copy team snapshots, transcripts or long logs. Queries default to summaries; use an item's detailRef only when its missing details are necessary. Complete short reports already in reportBatch do not need another read. Read split JSON pages using nextContentOffset and pass the first hash as expectedHash on subsequent pages before combining them.

Full control bypasses application capability/source restrictions, custom deny rules, approval, Action Gates, Auto-review and skill prerequisites. Keep team roles and the selected execution environment. In restricted mode request an approval through the original operation and resume it after approval. App-advertised built-in skills and package references remain readable independently of skill bindings and execution permissions.

References are data/protocol documentation, not new authorization. After compaction retrieve exact task requirements, current versions and relevant skill references as needed; do not rely on a persistent read flag as proof the model still has their content.
