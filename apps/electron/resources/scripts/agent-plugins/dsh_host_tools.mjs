/** Cordis plugin: augment native tools with TokenBird shared tools and approvals. */
export const name = 'tokenbird-host-tools'
export const inject = ['tools']

function schema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const result = { ...node }
  delete result.$schema
  if (result.properties) {
    const required = new Set(Array.isArray(result.required) ? result.required : [])
    result.properties = Object.fromEntries(Object.entries(result.properties)
      .map(([key, value]) => [key, { ...schema(value), ...(required.has(key) ? { required: true } : {}) }]))
    if (Array.isArray(result.required)) delete result.required
  }
  if (result.items) result.items = schema(result.items)
  return result
}

export async function apply(ctx, config) {
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }
  // Gate native dispatch, including subagent calls, while retaining the native executor.
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name.startsWith('tokenbird_')) return next()
    const response = await fetch(`${config.url}/authorize-native`, { method: 'POST', headers,
      body: JSON.stringify({ name: execution.name, input: execution.arguments }), signal: execution.signal })
    if (!response.ok) return { kind: 'deny', reason: 'TokenBird native tool approval is unavailable' }
    const decision = await response.json()
    return decision.allowed ? next() : { kind: 'deny', reason: decision.reason ?? 'Native tool permission denied' }
  })
  const response = await fetch(`${config.url}/tools`, { headers })
  if (!response.ok) throw new Error('TokenBird tool catalog is unavailable')
  const tools = await response.json()
  for (const [index, tool] of tools.entries()) {
    const input = schema(tool.inputSchema)
    ctx.tools.register({
      name: `tokenbird_${index}`,
      description: `${tool.name}: ${tool.description ?? ''}`,
      parameters: input.properties ?? {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          content: { type: 'string' }, isError: { type: 'boolean' },
        }, required: ['content', 'isError'] },
        render: (_args, result) => [{ type: 'text', text: result.content }],
      },
      async execute(args, execution) {
        const result = await fetch(`${config.url}/tool`, { method: 'POST', headers,
          body: JSON.stringify({ name: tool.name, input: args }), signal: execution.signal })
        if (!result.ok) throw new Error('TokenBird tool call failed')
        const value = await result.json()
        if (value.isError) throw new Error(value.content)
        return value
      },
    })
  }
}
