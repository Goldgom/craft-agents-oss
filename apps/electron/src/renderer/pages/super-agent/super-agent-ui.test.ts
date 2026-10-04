import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { applyPreset, configError, createConfig, nodeModels, scriptAccessGranted, withExecuteMode, type SuperAgentText } from './super-agent-ui'

const text: SuperAgentText = key => key
const tokenNest: LlmConnectionWithStatus = {
  slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
  oauthProvider: 'tokennest', isAuthenticated: true, createdAt: 1,
  channelGroup: 'text',
  defaultModel: 'available-model',
  models: ['available-model', 'available-mini', 'private-opus', 'gpt-image-1'],
  channelGroups: [
    { id: 'text', name: 'Text', models: ['available-model', 'available-mini', 'gpt-image-1'] },
    { id: 'private', name: 'Private', models: ['private-opus'] },
  ],
}

describe('Super Agent model authorization and setup', () => {
  it('starts the whole team in Execute with full control disabled until selected', () => {
    const config = createConfig([tokenNest], text)
    expect(config.environment.permissionMode).toBe('allow-all')
    expect(config.environment.fullControl).toBe(false)
    expect(config.environment.permissions).toEqual({ readFiles: true, writeFiles: false, runPrograms: false, browser: false })
  })

  it('keeps legacy settings limited and preserves the selected control mode across presets', () => {
    const config = createConfig([tokenNest], text)
    delete config.environment.fullControl
    expect(withExecuteMode(config).environment.fullControl).toBe(false)
    for (const fullControl of [true, false]) {
      config.environment.fullControl = fullControl
      const environment = structuredClone(config.environment)
      expect(withExecuteMode(config).environment).toEqual(environment)
      for (const preset of ['custom', 'balanced', 'fast', 'deep'] as const) {
        expect(applyPreset(config, preset, tokenNest, text).environment).toEqual(environment)
      }
    }
  })

  it('allows scripts with full control while preserving limited-mode capability requirements', () => {
    const environment = createConfig([tokenNest], text).environment
    environment.fullControl = false
    environment.permissions = { readFiles: false, writeFiles: false, runPrograms: false, browser: false }
    expect(scriptAccessGranted(environment)).toBe(false)
    expect(scriptAccessGranted({ ...environment, fullControl: true })).toBe(true)
    environment.permissions.runPrograms = true
    expect(scriptAccessGranted(environment)).toBe(false)
    expect(scriptAccessGranted({ ...environment, kind: 'sandbox' })).toBe(true)
    environment.permissions = { readFiles: true, writeFiles: true, runPrograms: true, browser: true }
    expect(scriptAccessGranted(environment)).toBe(true)
  })

  it('keeps legacy environment boundaries and capabilities when editing or choosing any preset', () => {
    const legacy = createConfig([tokenNest], text)
    legacy.environment.permissionMode = 'safe'
    legacy.environment.workingDirectory = 'C:\\limited-work'
    legacy.environment.permissions = { readFiles: false, writeFiles: true, runPrograms: false, browser: false }
    const edited = withExecuteMode(legacy)
    expect(edited.environment).toEqual({ ...legacy.environment, permissionMode: 'allow-all' })
    expect(legacy.environment.permissionMode).toBe('safe')
    for (const preset of ['custom', 'balanced', 'fast', 'deep'] as const) {
      expect(applyPreset(legacy, preset, tokenNest, text).environment).toEqual(edited.environment)
    }
  })

  it('keeps TokenNest node models within the inherited text group', () => {
    expect(nodeModels(tokenNest)).toEqual(['available-model', 'available-mini'])
  })

  it('builds every preset from available account models without crossing groups', () => {
    const config = createConfig([tokenNest], text)
    for (const preset of ['balanced', 'fast', 'deep'] as const) {
      const result = applyPreset(config, preset, tokenNest, text)
      expect(result.nodes.filter(node => node.role === 'coordinator')).toHaveLength(1)
      expect(result.nodes.some(node => node.role === 'worker')).toBe(true)
      for (const node of result.nodes) {
        expect(nodeModels(tokenNest)).toContain(node.model)
        expect(node.llmConnection).toBe(tokenNest.slug)
      }
    }
    expect(applyPreset(config, 'fast', tokenNest, text).nodes.every(node => node.model === 'available-mini')).toBe(true)
  })

  it('rejects saved model choices after authentication or group access is removed', () => {
    const config = createConfig([tokenNest], text)
    config.environment.workingDirectory = 'C:\\work'
    expect(configError(config, [tokenNest], text)).toBeNull()
    expect(configError(config, [{ ...tokenNest, isAuthenticated: false }], text)).toBe('nodeRequired')
    config.nodes[1].model = 'private-opus'
    expect(configError(config, [tokenNest], text)).toBe('nodeRequired')
  })

  it('requires exactly one coordinator and at least one worker before activation', () => {
    const config = createConfig([tokenNest], text)
    config.environment.workingDirectory = 'C:\\work'
    expect(configError({ ...config, nodes: [config.nodes[0]] }, [tokenNest], text)).toBe('nodesRequired')
    expect(configError({ ...config, nodes: [...config.nodes, { ...config.nodes[0], id: 'extra-coordinator' }] }, [tokenNest], text)).toBe('nodesRequired')
  })
})
