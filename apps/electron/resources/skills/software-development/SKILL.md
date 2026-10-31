---
name: software-development
description: Implement and debug scoped software changes, integrations, scripts and interfaces across frontend, backend, desktop and mobile projects using the actual repository and execution environment.
---

# Software development

Read repository instructions, the relevant call path and existing tests before changing code. Trace a defect from its observed input to the failing component, preserving exact errors and versions. Use the project's language, architecture, dependency manager and conventions; do not assume a runtime or framework from a model's name.

Define the behavior and affected interfaces from the assigned acceptance criteria. Implement the necessary path through UI, service, storage and integration layers when the request spans them. Preserve unrelated worktree changes and existing product semantics. A mechanical maintenance assignment permits its specified edits; a review or check-running assignment does not grant implementation ownership.

For new interfaces, handle real loading, failure, empty and interaction states. For APIs and persistence, check compatibility, authorization, validation and failure recovery where the changed behavior depends on them. Use the tools actually exposed; connected MCP tools are not interchangeable with shell access.

Run checks that address the changed behavior and remaining risks. Record commands, exit status, revision and artifacts, separating static checks from actual runtime proof. Keep dependencies and lockfiles stable unless the change requires them. Supply reproducible failure evidence when the environment prevents a check.

Own the complete assigned behavior through caller integration and verification. Do not silently replace a requested working feature with a stub, demo, interface subset or instructions. If code, dependencies or configuration you were assigned to deliver prevent use, diagnose and repair them within existing authorization before concluding; a partial implementation is not an external blocker. For integrations, test the real entry point and registered interface of the delivered version, including relevant failure and recovery behavior. Report remaining gaps without abandoning other executable work or claiming local checks prove deployment.

In a Super Agent team, modify only assigned resources and report the diff, verification and remaining gaps to the orchestrator. Do not create nested agents or call another model. Preparation, packaging, deployment and acceptance are distinct outcomes; deployment requires the existing task's authorization and a verified target.
