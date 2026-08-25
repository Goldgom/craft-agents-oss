---
name: source-authoring
description: Configure API, MCP, and local-folder sources with the minimum access and a useful guide for agents.
---

# Source authoring

Use this skill for creating or changing a source. Read `~/.craft-agent/docs/sources.md` before editing source configuration.

First choose the source type that matches the integration: API for a direct HTTP service, MCP for a tool server, or Local Folder for an explicitly scoped directory. Preserve credentials and never place secret values into guide files, prompts, or logs.

Ask only for connection details that are required. Scope URLs, filesystem roots, tools, and permissions as narrowly as possible. For APIs, document authentication assumptions and useful endpoints. For MCP, verify the server command or endpoint and expose only tools the workflow requires. For local folders, avoid broad roots and confirm the permitted location.

Write a short guide that tells the agent what the source is for, how to use it safely, and what important entities or conventions mean. Validate the configuration and report any credential or authorization step that remains with the user.
