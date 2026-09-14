/**
 * Codex Responses compatibility runtime.
 *
 * Codex transport support lives in the Pi SDK (`openai-codex-responses`). This
 * subclass deliberately reuses Pi's mature process, permission, MCP, recovery,
 * and teardown implementation while selecting the independent Codex prompt
 * profile. It is not the legacy native `codex app-server` backend removed in
 * v0.5.0.
 */
import { PiAgent } from './pi-agent.ts';

export class CodexAgent extends PiAgent {
  protected backendName = 'Codex compatibility runtime';
}
