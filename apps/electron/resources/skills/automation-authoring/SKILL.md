---
name: automation-authoring
description: Create or update event-driven automations, cron schedules, and background script monitors in automations.json.
---

# Automation authoring

Use this skill when the user wants work to begin after an application event, on a schedule, or after a monitor detects a signal. Read `~/.craft-agent/docs/automations.md` before changing configuration.

## Choose the trigger

- Use an application event such as `LabelAdd`, `SessionStatusChange`, or `PermissionModeChange` when Craft state changes should trigger work.
- Use `SchedulerTick` with a five-field cron expression and timezone for calendar-based work.
- Use `HostedScriptTick` for polling or health checks. It runs on startup and then every `intervalMs`; return `false`, `null`, or `undefined` to do nothing, or a JSON-safe truthy value to trigger actions.

## Configure an action

Use a `prompt` action to start a dedicated model session. Write the prompt so it explains the signal, the expected output, and any safe next action. The result of a hosted script is automatically appended as `[Hosted script info]`.

Use `webhook` only when the user needs an external HTTP notification or integration. Preserve existing connection, model, thinking level, labels, and permission mode unless the user requests a change.

## Script monitors

Hosted scripts are sandboxed. They receive `metadata` and `input` and may use only capabilities explicitly granted by `scriptPermissions`:

- `api.env(name)` for allowlisted environment variable names.
- `await api.readFile(relativePath)` for allowlisted, read-only workspace paths.
- `await api.fetch(url)` for allowlisted HTTP(S) origins, GET/HEAD only.

Start with no external permissions. Request only the smallest named environment variables, workspace paths, or origins needed. Do not grant command execution, writes, arbitrary filesystem access, or arbitrary network access.

Validate `intervalMs`, `scriptTimeoutMs`, the script result condition, and the model prompt before saving. Explain when it runs and what signal triggers the model.
