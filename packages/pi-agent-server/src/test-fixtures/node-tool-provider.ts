/** Offline model endpoint: inspect real wire schemas, call the assigned tool and inspect its result. */
let calls = 0
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== 'https://node-tools.invalid/v1/chat/completions') throw new Error('OFFLINE_FETCH_BLOCKED')
  const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')))
  const role = String(body.model).replace('node-tools-', '')
  const name = `mcp__session__${role === 'coordinator' ? 'super_agent_submit_request' : role === 'planner' ? 'super_agent_intent' : role === 'orchestrator' ? 'super_agent_dispatch' : 'computer_use'}`
  const first = ++calls === 1
  if (first) {
    const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    process.stdout.write(JSON.stringify({ type: 'test_node_tools', role, tools }) + '\n')
    if (!tools.includes(name)) throw new Error(`Required node tool missing: ${name}`)
  } else {
    process.stdout.write(JSON.stringify({ type: 'test_node_result', role, hasImage: JSON.stringify(body.messages).includes('data:image/png;base64,') }) + '\n')
  }
  const args = role === 'coordinator' ? { requestId: 'forward' } : role === 'planner' ? { sourceRequestId: 'original', requestId: 'handoff', goal: 'Research the model', constraints: [], deliverables: ['Report'], acceptanceCriteria: ['Sources verified'] }
    : role === 'orchestrator' ? { requestId: 'dispatch', nodeId: 'desktop', title: 'Inspect app', instructions: 'Observe and verify the desktop app' } : { action: 'screenshot' }
  const delta = first ? { tool_calls: [{ index: 0, id: 'node-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'Node tool completed.' }
  const chunk = { id: `node-response-${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}, { preconnect() { throw new Error('OFFLINE_FETCH_BLOCKED') } }) as typeof fetch
