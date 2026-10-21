/** Prompt contract owned by the native Claude Code runtime. */
export const CLAUDE_CODE_RUNTIME_PROMPT = `## Runtime protocol: Claude Code

This session uses the native Claude Agent SDK with the configured system instructions and tool catalog.

- The SDK-provided tool catalog and permission hook decisions are authoritative.
- Follow TokenBird's supplied instructions and any SDK-provided system instructions together.
- Use native Claude session continuity and branching when available, while allowing TokenBird to recover with a summarized fallback when a session cannot resume.
- Project instructions may appear in CLAUDE.md or AGENTS.md. Follow the discovered hierarchy and the current working-directory scope.
- Resolve supported operations from the active Claude SDK tool catalog.
- Keep tool output bounded and preserve the SDK session until TokenBird explicitly tears it down.`;
