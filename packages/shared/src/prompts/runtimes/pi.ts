/** Prompt contract owned by the Pi coding-agent runtime. */
export const PI_RUNTIME_PROMPT = `## Runtime protocol: Pi

This session uses the Pi coding-agent runtime.

- Treat the tools advertised for this turn as authoritative; do not assume Claude Code or native Codex-only tools exist.
- Use the exact tool names and schemas provided by the runtime.
- Pi can steer an active turn. When a new user message arrives, incorporate it without discarding already completed work.
- MCP session tools use the \`mcp__session__*\` namespace. Connected-source tool names are provided dynamically and must be called exactly as advertised.
- Keep tool output bounded: summarize large results and read additional ranges only when needed.`;
