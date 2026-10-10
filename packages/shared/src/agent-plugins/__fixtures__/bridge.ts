/** Real subprocess fixture for the plugin contract. No provider/model requests. */
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let state: any;
let active: any;
const event = (turnId: string, event: object) => send({ method: 'agent/event', params: { turnId, event } });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    state = request.params;
    send({ id: request.id, result: { protocolVersion: 1, capabilities: ['resume', 'hostTools', 'toolApproval', 'utilityCompletion'], sessionId: state.session.nativeSessionId ?? 'fixture-native-session' } });
  } else if (request.method === 'agent/query') {
    send({ id: request.id, result: { text: 'utility result', model: state.connection.model } });
  } else if (request.method === 'agent/chat') {
    const params = request.params;
    if (params.message.includes('hang')) return;
    if (params.message.includes('crash')) { process.exit(7); }
    if (params.message.includes('invalid')) { event(params.turnId, { type: 'text_delta', text: 42 }); return; }
    if (params.message === 'write-file') {
      active = request;
      send({ id: 'write', method: 'host/tool', params: { turnId: params.turnId, toolName: 'Write', input: {
        file_path: `${state.session.workspaceRootPath}/approved-output.txt`, content: 'Written through shared host tools' } } });
      return;
    }
    if (params.message.includes('authorize')) {
      active = request;
      send({ id: 'authorize', method: 'host/authorize', params: { turnId: params.turnId, toolName: 'Write', input: { file_path: `${state.session.workspaceRootPath}/result.txt`, content: 'test' } } });
      return;
    }
    if (params.message.includes('read')) {
      active = request;
      send({ id: 'read', method: 'host/tool', params: { turnId: params.turnId, toolName: 'Read', input: { file_path: `${state.session.workspaceRootPath}/instructions.md` } } });
      return;
    }
    // Late notifications must never be inserted into another turn's history.
    event('old-turn', { type: 'text_delta', text: 'STALE' });
    event(params.turnId, { type: 'text_delta', text: 'hello ' });
    event(params.turnId, { type: 'text_complete', text: `hello ${params.thinkingLevel}; prompt=${params.systemPrompt.includes('plugin')} ; credentials=${!!state.credentials}; ambient=${!!process.env.OPENAI_API_KEY}` });
    event(params.turnId, { type: 'complete', usage: { inputTokens: 5, outputTokens: 2 } });
    send({ id: request.id, result: { sessionId: 'fixture-native-session' } });
  } else if (active && (request.id === 'read' || request.id === 'authorize' || request.id === 'write')) {
    event(active.params.turnId, { type: 'text_complete', text: JSON.stringify(request.result) });
    event(active.params.turnId, { type: 'complete' });
    send({ id: active.id, result: {} }); active = null;
  }
});
