---
name: source-authoring
description: Use, create, authenticate, and validate API, MCP, and local-folder sources with minimum access and a useful agent guide.
---

# Source authoring

Use this skill for using, creating, or changing a source. Read `~/.tokenbird/docs/sources.md` before editing source configuration.

For an existing source, read its `config.json` and `guide.md`, then call the requested source tool directly. Do not recreate it, scan the workspace for examples, or substitute `source_test` for the requested action.

First choose the source type that matches the integration: API for a direct HTTP service, MCP for a tool server, or Local Folder for an explicitly scoped directory. Preserve credentials and never place secret values into guide files, prompts, or logs.

Ask only for connection details that are required. Scope URLs, filesystem roots, tools, and permissions as narrowly as possible. For APIs, document authentication assumptions and useful endpoints. For MCP, verify the server command or endpoint and expose only tools the workflow requires. For local folders, avoid broad roots and confirm the permitted location.

Write a short guide that tells the agent what the source is for, how to use it safely, and what important entities or conventions mean. Validate the configuration and report any credential or authorization step that remains with the user.

For Codex-style runtimes, source MCP tools are named from the source slug, not an internal ID. Use `mcp__sources__{slug}__list_tools` when discovery is needed and call MCP functions directly rather than through the shell.

Run `source_test` once after authoring, before authentication. Then trigger the correct credential or OAuth tool. If a freshly authenticated MCP source still reports authentication required, ask the user to re-enable the source or restart the session instead of repeatedly testing or retrying.
