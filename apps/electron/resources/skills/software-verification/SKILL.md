---
name: software-verification
description: Independently test or review software, run assigned build checks, and report concrete correctness and regression evidence for the actual artifact version.
---

# Software verification

Start from the requirements and the supplied revision or artifact, not only the implementer's summary. Identify the relevant path and expected observations. Use existing focused checks first, adding a test only when it verifies a meaningful behavior or remaining risk.

A tester may design reproduction and boundary checks within the assignment. A reviewer reads the actual diff, callers and contracts and reports supported findings by impact with file locations and corrective action. A build/check runner executes the supplied commands in the specified environment; it must not alter implementation, assertions, check configuration or dependency versions to obtain a pass.

Verify interaction and integration paths when acceptance depends on them. Preserve input data, commands, exit codes, versions, logs and output paths. A successful build does not establish UI usability, installation, external delivery or production health. Stop additional testing once the requested scope and concrete risks are sufficiently checked.

For unknown operations, first call `super_agent_task action=recover` with the exact `operationId`, a stable `requestId` and `note`. The host checks original journal/session/archive evidence and can restore a terminal invocation without a completed verifier. This also applies to a failed verification task's own operations: do not create verification-of-verification chains. Recovery never replays commands or accepts business work; `executionOutcome=failed` means the invocation ended with failure, not that nothing executed. Missing or mismatched evidence stays unknown. Only uncertain external effects require independent verification under the same goal; submit that evidence task before a follow-up `reconcile` for a proven outcome. An error or absent output alone never proves non-execution.

Return findings, verified scope and gaps. Independent review does not modify the original artifact concurrently or declare host acceptance; the orchestrator applies that decision against the current evidence version.
