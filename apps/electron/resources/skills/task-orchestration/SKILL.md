---
name: task-orchestration
description: Route authorized work to Super Agent workers by their bound skills, framework, model and availability, then manage dependencies and evidence-based acceptance across scenarios.
---

# Task orchestration

Read the current intent and team state. Match the task to each worker's `skillCatalog` descriptions, assigned skill slugs, role, framework limitations, authorized sources and scheduling state. Skills are instructions, not proof of model competence or available tools. Prefer a specialist when present; otherwise assign a bounded cross-scenario task to a supporting worker with a matching skill. Split difficult work into verifiable stages and ask the interaction node for decisions that cannot be inferred.

Examples of routing:

- Implementation and debugging: `software-development`; independent testing and review: `software-verification` and `evidence-review`.
- Literature and current facts: `web-research` with `browser-automation`; experiments, numerical or domain analysis: `research-methods` and `structured-data`.
- Office files and reports: `document-workflows`; visual artifacts: `previews-and-diagrams`, `pages-authoring`, `canvas-editing` or `theme-package-design`.
- Service diagnosis, remediation and recovery: `incident-response` and `remote-operations`.
- Everyday writing, learning, planning and errands: `everyday-assistance`; desktop interaction: `windows-desktop-control`.
- Information and memory: `knowledge-organization`; product integration/configuration packages: the relevant authoring skill; delivery and handoff: `messaging-and-collaboration`.

Create stable task IDs with concrete inputs, ownership, outputs and acceptance criteria. Parallelize independent work; put exclusive write paths in `resources`. Keep one writer per artifact and use `dependsOn` and `reviewOf` for the actual dependency graph. Keep cross-scenario work within the original goal and current team workflow, without creating another team or changing provider credentials.

Keep every requested outcome assigned until it is delivered or has a specific external blocker. Bounded tasks divide the work, not the user's acceptance conditions. A worker-created MCP missing a required operation or runtime dependency needs an implementation/repair assignment within existing authorization, not a report that hands the unfinished integration back to the user. Check the actual caller-to-result path for the delivered version; unit tests and health checks alone do not establish a usable integration.

For ongoing work, distinguish a scan result from the end of the monitoring/management window. An active worker must checkpoint and register a supported wait before ending its turn. If it has already completed, inspect unsettled effects and ownership, then dispatch only the remaining work with a new task ID under the same goal and plan once exclusive handoff is confirmed. A message does not reactivate a completed task. Do not invent a requirement to revive the same task or keep the same worker forever. Verify actual scheduling and resume limits before promising the next run.

Workers perform analysis and verification. Use the bound `super-agent-collaboration` skill and its registered tools for plans, dispatch, messages and acceptance. Accept only completed reports for the current goal and artifact version. Unknown operations require independent verification and a later reconciliation turn before acceptance; dispatch verification before retrying acceptance. Preserve applied receipts and completed work when repairing rejected calls. Communicate deliverables or blockers to `interactionNodeId`; do not report a queued action as completed.
