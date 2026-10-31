---
name: super-agent-collaboration
description: Coordinate authorized work inside an active TokenBird Super Agent team using registered collaboration tools, durable plans and shared evidence. Applies to interaction, orchestration and worker nodes within their assigned roles.
---

# Super Agent collaboration

Use the session collaboration tools (`mcp__session__super_agent_*`). Their parameter schemas are supplied by the host. Submit ordinary tool arguments, not JSON strings or control blocks in prose. Tool results are execution receipts: a queued task is not completed work, and a normal model turn is not acceptance.

## Roles and tools

| Tool | Purpose | Node |
| --- | --- | --- |
| `super_agent_intent` | Hand off a goal or revise an existing goal contract | Interaction |
| `super_agent_dispatch` | Assign one bounded task to a worker | Orchestrator |
| `super_agent_plan` | Create or replace a plan using its revision | Orchestrator |
| `super_agent_accept` | Record acceptance or rejection against completed evidence | Orchestrator |
| `super_agent_message` | Send a concise internal message using `toNodeId` and `body` | All, within role boundaries |
| `super_agent_board` | Create or replace a durable shared-board item | Orchestrator, worker |
| `super_agent_resources` | Activate installed skills and team-authorized sources | Orchestrator, worker for self |
| `super_agent_deliver` | Select a user-facing reply and optional stage/final artifact delivery | Interaction |
| `super_agent_script` | Register a script, or run an assigned script under current authorization | Worker |

A legacy team without a separate orchestrator allows its coordinator to manage plans and tasks. A separated interaction node only hands off intent, messages the orchestrator and communicates with the user. Workers never assign tasks, change plans or accept work. Skill instructions do not grant tools, sources, credentials or additional model calls.

## Calls, receipts and recovery

Each call has a `requestId`, unique within this turn. Use a short descriptive ID. Retry identical parameters with the same ID to retrieve the committed receipt without repeating the action. Corrected parameters require a new ID. Inspect applied IDs and current state before continuing after a connection failure; already committed work survives retries and process restarts.

At most eight collaboration actions and four new tasks may be submitted per turn. Node messages remain subject to the communication hop and total turn budgets in the current team state. No-op confirmations and repeated unchanged blockers do not advance work.

If a call fails, read its error and fix that operation in the current turn. Schema errors commit nothing. Revision conflicts require refreshing state and merging valid information. Some runtime failures can follow committed effects: preserve the returned receipt and retry only the remaining work. Do not mix collaboration tools with a legacy final control block in the same turn.

## Interaction

Preserve the user's goal, constraints, deliverables and acceptance criteria. `super_agent_intent` requires `goal`, `constraints`, `deliverables` and `acceptanceCriteria`; the last three are string arrays. Clarify only missing information that materially affects the outcome. Status queries and result relays reuse the existing goal. Actual requirement changes use the goal's `id` and current `expectedRevision`.

Ordinary answers to a direct user request can be final text. For results from internal turns, use `super_agent_deliver` with `reply` to explicitly select what the user receives; it is published after a successful turn. Use optional `delivery` with `kind=stage` or `kind=final`, a title and registered `artifactIds` for a delivery card. Files must exist and match their registered fingerprints. A final card does not accept work or complete a goal. Use `reply=""` when an internal turn has no user-facing news. Do not repeat a delivery in final prose.

Relay new verified results, concrete decisions or requested status. Queueing, internal handoffs and routine inspections remain silent. Check recent `userReplies` before relaying the same result again.

## Orchestration

Own the goal through delivery. Assign concrete work and follow unresolved items through diagnosis, repair and verification. Handoffs contain the objective, necessary inputs, outputs and completion checks; carry forward only constraints that actually apply to the current task. Do not add boilerplate disclaimers, unrelated prohibitions or automatic stop conditions from old conversations.

Match each task to worker responsibilities, `skillCatalog`, actual framework capabilities, source permissions and scheduling state. Prefer an appropriate specialist. Provide goal, scope, necessary input paths/versions, dependencies, outputs and observable acceptance criteria. Reference board IDs and artifact paths instead of copying history or logs.

Create or refresh the plan before dispatching its tasks. A new plan uses `expectedRevision=0`; an update uses the same `id` and current revision. `super_agent_dispatch` requires `title` and `instructions`; specialist assignments specify `nodeId`. Use stable task IDs to prevent redispatch. `dependsOn` names existing task IDs, so submit prerequisites first. Independent tasks may run in parallel; give shared files and external write resources one owner through `resources`.

Keep the same `goalId` and `planId` across stages. `goalCriteria` contains zero-based indexes into the goal's acceptance criteria. Changed goal revisions need refreshed plan contracts and verification; old outputs remain historical evidence. Choose `thinkingLevel` only when the node permits a task override.

When the workflow requires independent review, every production task declares non-empty `acceptanceCriteria`. Assign review to another worker, with `reviewOf` and `dependsOn` pointing to the production task. A review task does not recursively need another review.

Accept only completed work with a completed evidence task and current artifact versions. `super_agent_accept` uses `taskId`, `evidenceTaskId`, `status=accepted/rejected` and a concrete evidence `note`. Unsettled operations require independent verification followed by reconciliation through `super_agent_task`; dispatch verification before retrying acceptance. Rejection of mistaken acceptance invalidates dependent conclusions. Do not change accepted evidence after dependents have started; create a new versioned task.

Only complete a plan after all linked work, verification and script results are handled. Describe internal recoverable blockers with `blocker.kind=system` and a concrete `systemAction`; wait for the user only when specific information, authorization or a decision is missing, using `blocker.kind=user` and `userAction`.

Check the original user outcome before closing: completing an investigation, describing a missing tool or submitting a scan is not completion of an implementation or ongoing management goal. Repair team-authored missing functionality within existing authorization, or assign the specific remaining work. Do not add restrictions such as “only the original task may continue” when the user required exclusive access rather than permanent task identity. After checking unsettled effects and completing exclusive handoff, remaining authorized work may use a new task ID under the same goal and plan, without replaying completed effects.

## Shared state and worker progress

Read `collaboration_board` with `action=get` for complete entries and revisions. `super_agent_board` writes one item with `title`, `content` and `expectedRevision`; updates also need its existing `id`. Read the full entry before replacing it and retain valid content from other nodes. The board stores reusable findings, interfaces, ownership, artifact indexes and blockers. It is not a chat log or authority to expand the task.

Workers check relevant shared state before starting, using dependencies and delivering. Execute only their assigned scope, preserve existing work and report actual artifacts, evidence, remaining conditions and blockers. The host summarizes a completed task automatically; do not send a duplicate completion message.

Communicate actual work: what changed, what was checked, and the next concrete action or input needed. Diagnose failures within current authorization, correct recoverable errors and continue independent work. Stop ineffective retries rather than abandoning the whole goal; coordinate a specific recovery with the orchestrator. Respect an explicit task instruction to stop and verify uncertain side effects before replaying an operation. Reviewers perform available checks and give actionable findings; orchestrators assign fixes and close the loop. Keep limitations brief and relevant to acceptance, report failures honestly, and avoid repeated defensive statements or passing responsibility between nodes.

Use existing `super_agent_task` for task/operation reads, checkpoints, concrete waits, artifact registration and reconciliation. Use `super_agent_library` for long-term memory and immutable archives. Verify unknown outcomes against original receipts and authoritative state, without replaying an operation whose effects are uncertain.

For ongoing assigned work, report a scan or intermediate result as a stage. Save a checkpoint and register a concrete supported wait while the task is still active, then read back the registration before ending the turn; check actual scheduler settings and resume limits before promising continuation. A stage report alone does not keep a task active. Once a task has completed, a message turn cannot submit its stage or wait; coordinate a formal remaining-work assignment instead. Final means the assigned task scope is finished, not merely that this model turn should end.

## Resources and scripts

Select only installed skills and sources from `resourceCatalog`. Orchestrators activate resources for idle workers before dispatching. Workers may activate resources only for themselves, then end the turn; the host resumes the original task with the refreshed skill/tool set and existing checkpoints. Activation does not authenticate a source or change its configuration.

`super_agent_script` with `action=register` supplies `script={id,name,path,args,timeoutSeconds}` and does not start it. `action=run` supplies only `scriptId`. Running still requires the current environment, assignment and authorization. In restricted mode, use the script panel's actual approval flow; this tool cannot grant approval or bypass the execution boundary.
