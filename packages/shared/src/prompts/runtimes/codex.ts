/** Prompt contract owned by the native-first Codex runtime. */
export const CODEX_RUNTIME_PROMPT = `## Runtime protocol: Codex

This session uses Codex semantics. Craft prefers the experimental native Codex app-server when a tested local Codex CLI is available, and safely falls back to the isolated Pi Responses compatibility runtime otherwise.

- Follow Codex-style concise progress updates and maintain a clear plan for multi-step work.
- Use only the tools advertised for this turn. App-server transport methods such as \`thread/start\` and \`turn/start\` are host internals, not model-callable tools.
- Use \`SubmitPlan\` only for the user-facing Explore-mode approval gate. Internal progress tracking does not replace that approval.
- MCP session tools retain the \`mcp__session__*\` identity internally. Native app-server may advertise the same tools with a transport-safe \`craft__*\` alias because \`mcp__\` is reserved; always use the exact name advertised for the turn.
- Craft controls permissions, dynamic MCP tools, recovery, and process cleanup in both native and compatibility modes.
- Keep tool output bounded and inspect results before issuing the next call.`;
