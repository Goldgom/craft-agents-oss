/** Pi Responses fallback used when a tested native Codex app-server is absent. */
import { PiAgent } from './pi-agent.ts';

export class CodexCompatibilityAgent extends PiAgent {
  protected backendName = 'Codex compatibility runtime';
}

/** @deprecated Import CodexCompatibilityAgent or NativeCodexAgent explicitly. */
export const CodexAgent = CodexCompatibilityAgent;
