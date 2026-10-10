import type { AgentBackend, BackendConfig } from '../agent/backend/types.ts';
import { AbortReason } from '../agent/backend/types.ts';
import type { LLMQueryRequest } from '../agent/llm-tool.ts';
import type { BackendFrameworkConfiguration } from './frameworks.ts';
import { registerFrameworkToolPolicy } from './framework-tool-policy.ts';

/** Compose shared implementations around the selected framework's own loop. */
export function configureFrameworkAgent(agent: AgentBackend, configuration: BackendFrameworkConfiguration,
  config: BackendConfig, createUtility: () => AgentBackend, recoverHistory?: BackendConfig['getRecoveryMessages']): AgentBackend {
  const releasePolicy = config.session?.id ? registerFrameworkToolPolicy(config.session.id, agent, configuration.features) : () => {};
  let utility: AgentBackend | undefined;
  if (configuration.features.utility === 'host') {
    const query = (request: LLMQueryRequest) => {
      utility ??= createUtility();
      if (!utility.queryLlm) throw new Error('This model connection cannot provide shared auxiliary inference');
      return utility.queryLlm(request);
    };
    agent.queryLlm = query;
    agent.runMiniCompletion = async prompt => (await query({ prompt })).text;
  }
  if (configuration.features.steering === 'disabled') {
    agent.redirect = () => { agent.forceAbort(AbortReason.Redirect); return false; };
  }
  if (recoverHistory) {
    const chat = agent.chat.bind(agent);
    let pending = true;
    agent.getSessionId = () => null;
    agent.setSessionId = () => {};
    agent.chat = async function* (message, attachments, options) {
      const history = pending ? recoverHistory() : undefined;
      const context = history?.length ? '<conversation_recovery>\n' + history.slice(-40)
        .map(item => `${item.type}: ${item.content.slice(0, 2000)}`).join('\n\n') + '\n</conversation_recovery>\n\n' : '';
      let completed = false;
      let failed = false;
      for await (const event of chat(context + message, attachments, options)) {
        if (event.type === 'error') failed = true;
        if (event.type === 'complete') completed = true;
        yield event;
      }
      if (completed && !failed) pending = false;
    };
  }
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => { releasePolicy(); utility?.destroy(); utility = undefined; destroy(); };
  return agent;
}
