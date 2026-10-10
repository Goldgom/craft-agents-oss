import type { AgentRuntimeProtocol } from '../../config/llm-connections.ts';
import { CLAUDE_CODE_RUNTIME_PROMPT } from './claude-code.ts';
import { CODEX_RUNTIME_PROMPT } from './codex.ts';
import { PI_RUNTIME_PROMPT } from './pi.ts';

export function inferAgentRuntimeFromBackendName(backendName?: string): AgentRuntimeProtocol {
  if (backendName?.toLowerCase().includes('codex')) return 'codex';
  if (backendName?.toLowerCase().includes('claude')) return 'claude-code';
  return 'pi';
}

export function getAgentRuntimePrompt(runtime: AgentRuntimeProtocol): string {
  switch (runtime) {
    case 'claude-code': return CLAUDE_CODE_RUNTIME_PROMPT;
    case 'codex': return CODEX_RUNTIME_PROMPT;
    case 'pi': return PI_RUNTIME_PROMPT;
    default: return 'Use the tools and capabilities supplied by the active agent plugin. Request host authorization before executing native tools, follow the returned arguments, and respect denied operations. Do not assume Pi, Claude Code, or Codex-specific commands are available.';
  }
}

export { CLAUDE_CODE_RUNTIME_PROMPT, CODEX_RUNTIME_PROMPT, PI_RUNTIME_PROMPT };
