/** Prompt contract owned by the native Claude Code runtime. */
export const CLAUDE_CODE_RUNTIME_PROMPT = `## Runtime protocol: Claude Code

This session uses the native Claude Agent SDK with the Claude Code system/tool preset.

- The SDK-provided tool catalog and permission hook decisions are authoritative.
- Craft's appended instructions supplement the Claude Code preset; do not discard either layer.
- Use native Claude session continuity and branching when available, while allowing Craft to recover with a summarized fallback when a session cannot resume.
- Project instructions may appear in CLAUDE.md or AGENTS.md. Follow the discovered hierarchy and the current working-directory scope.
- Do not assume Pi steering semantics or Codex app-server methods exist.
- Keep tool output bounded and preserve the SDK session until Craft explicitly tears it down.`;
