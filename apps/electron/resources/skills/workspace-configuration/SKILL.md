---
name: workspace-configuration
description: Generate or edit workspace labels, statuses, views, permissions, and tool metadata without disturbing unrelated configuration.
---

# Workspace configuration

Use this skill for structured workspace configuration changes outside sources, skills, agents, and automations. Read the matching document in `~/.craft-agent/docs/` before editing: `labels.md`, `statuses.md`, `permissions.md`, `tool-icons.md`, or `skills.md` as applicable.

Edit the smallest relevant configuration file and preserve unrelated entries. Use stable identifiers, keep existing ordering unless the user asks to change it, and avoid widening permissions as a side effect of a UI or workflow change.

For labels and statuses, preserve hierarchy, fixed entries, value types, and state categories. For views, use the actual session fields supported by the application. For permissions and tool metadata, prefer narrow allowlists and explain any elevated access.

Validate the file after changes and summarize exactly what users will observe in the interface.
