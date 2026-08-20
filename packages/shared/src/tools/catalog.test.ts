import { describe, expect, it } from 'bun:test'
import { getBuiltinToolCatalog } from './catalog'

describe('built-in tool catalog', () => {
  it('includes core filesystem tools and canonical session tools', () => {
    const tools = getBuiltinToolCatalog()
    expect(tools.some(tool => tool.category === 'core' && tool.name === 'Read')).toBe(true)
    expect(tools.some(tool => tool.category === 'core' && tool.name === 'Bash')).toBe(true)
    expect(tools.some(tool => tool.category === 'session' && tool.name === 'mcp__session__call_llm')).toBe(true)
    expect(tools.some(tool => tool.category === 'session' && tool.name === 'mcp__session__browser_tool')).toBe(true)
  })

  it('has stable unique names inside each category', () => {
    const keys = getBuiltinToolCatalog().map(tool => `${tool.category}:${tool.name}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
