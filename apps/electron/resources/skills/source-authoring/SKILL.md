---
name: source-authoring
description: Use, create, authenticate, and validate API, MCP, and local-folder sources with minimum access and a useful agent guide.
---

# Source authoring

Use this skill for using, creating, or changing a source. Read `~/.tokenbird/docs/sources.md` before editing source configuration.

For an existing source, read its `config.json` and its `guide.md` if present, then call the requested source tool directly. Do not recreate it, scan the workspace for examples, or substitute `source_test` for the requested action.

First choose the source type that matches the integration: API for a direct HTTP service, MCP for a tool server, or Local Folder for an explicitly scoped directory. Preserve credentials and never place secret values into guide files, prompts, or logs.

Ask only for connection details that are required. Scope URLs, filesystem roots, tools, and permissions as narrowly as possible. For APIs, document authentication assumptions and useful endpoints. For MCP, verify the server command or endpoint and expose only tools the workflow requires. For local folders, avoid broad roots and confirm the permitted location.

Write a short guide that tells the agent what the source is for, how to use it safely, and what important entities or conventions mean. Validate the configuration and report any credential or authorization step that remains with the user.

For Codex-style runtimes, use the connected source tools listed in `<sources>` and the runtime's callable tool catalog. Use each tool's advertised name and schema; tool naming can differ by runtime. Call MCP functions directly rather than through the shell.

Run `source_test` once after authoring, before authentication. Then trigger the correct credential or OAuth tool. After confirmed authentication, inspect the next callable tool catalog and retry a read-only operation once. If authentication still fails, report the source and sanitized error, check the configured authentication method and activation state, and explain any reconnect action needed. Do not restart the session blindly, expose credentials, or loop on source_test. Before retrying a write after a timeout, inspect its state to avoid duplicate actions.
