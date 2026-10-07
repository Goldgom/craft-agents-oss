import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { applyPreset, configError, createConfig, nodeModels, scriptAccessGranted, withExecuteMode, type SuperAgentText } from './super-agent-ui'
import { SUPER_AGENT_PRESETS, PRESET_RECIPES } from './super-agent-presets'
import { validateSuperAgentConfig } from '@craft-agent/shared/super-agent'

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
  it('starts the whole team in Execute with full control enabled by default', () => {
    const config = createConfig([tokenNest], text)
    expect(config.environment.permissionMode).toBe('allow-all')
    expect(config.environment.fullControl).toBe(true)
    expect(config.environment.permissions).toEqual({ readFiles: true, writeFiles: false, runPrograms: false, browser: false })
  })

  it('defaults missing control settings to full control and preserves explicit choices across presets', () => {
    const config = createConfig([tokenNest], text)
    delete config.environment.fullControl
    expect(withExecuteMode(config).environment.fullControl).toBe(true)
    for (const fullControl of [true, false]) {
      config.environment.fullControl = fullControl
      const environment = structuredClone(config.environment)
      expect(withExecuteMode(config).environment).toEqual(environment)
      for (const preset of ['custom', ...SUPER_AGENT_PRESETS] as const) {
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
    for (const preset of ['custom', ...SUPER_AGENT_PRESETS] as const) {
      expect(applyPreset(legacy, preset, tokenNest, text).environment).toEqual(edited.environment)
    }
  })

  it('keeps TokenNest node models within the inherited text group', () => {
    expect(nodeModels(tokenNest)).toEqual(['available-model', 'available-mini'])
  })

  it('builds every preset from available account models without crossing groups', () => {
    const config = createConfig([tokenNest], text)
    for (const preset of SUPER_AGENT_PRESETS) {
      const result = applyPreset(config, preset, tokenNest, text)
      expect(result.nodes.filter(node => node.role === 'coordinator')).toHaveLength(1)
      expect(result.nodes.some(node => node.role === 'worker')).toBe(true)
      for (const node of result.nodes) {
        expect(nodeModels(tokenNest)).toContain(node.model)
        expect(node.llmConnection).toBe(tokenNest.slug)
      }
    }
    expect(applyPreset(config, 'daily', tokenNest, text).nodes[1].model).toBe('available-mini')
  })

  it('defaults to daily assistance and gives autonomous scenarios distinct roles and continuation settings', () => {
    const config = createConfig([tokenNest], text)
    expect(config.nodes.map(node => node.name)).toEqual(['dailyLeadName', 'dailyWorkerName'])
    for (const preset of SUPER_AGENT_PRESETS) {
      const result = applyPreset(config, preset, tokenNest, text)
      result.environment.workingDirectory = 'C:\\work'
      expect(() => validateSuperAgentConfig(result)).not.toThrow()
      expect(result.nodes).toHaveLength(preset === 'daily' ? 2 : 4)
      expect(result.continuousWork).toBe(true)
      expect(result.idleInspectionMinutes).toBe({ daily: 60, coding: 10, research: 30, work: 15 }[preset])
      expect(result.nodes.map(node => node.workPreferences)).toEqual(PRESET_RECIPES[preset].nodes.map(node => `${node.profile}Preferences`))
    }
  })

  it('preserves ids and resource ownership when a smaller preset replaces a configured team', () => {
    const config = applyPreset(createConfig([tokenNest], text), 'coding', tokenNest, text)
    config.environment.workingDirectory = 'C:\\work'
    config.sourceSlugs = ['repo']
    config.nodes[1].sourceSlugs = ['repo']
    config.abilityProfiles = [{ id: 'review', name: 'Review', description: '', instructions: 'Review artifacts' }]
    config.nodes[2].abilityProfileIds = ['review']
    config.scripts = [{ id: 'checks', name: 'Checks', path: 'checks.ts', args: [], timeoutSeconds: 60, nodeId: config.nodes[3].id }]
    const original = structuredClone(config)
    const result = applyPreset(config, 'daily', tokenNest, text)
    expect(result.nodes.map(node => node.id)).toEqual(config.nodes.map(node => node.id))
    expect(result.nodes[1].sourceSlugs).toEqual(['repo'])
    expect(result.nodes[2].abilityProfileIds).toEqual(['review'])
    expect(result.scripts).toEqual(config.scripts)
    expect(() => validateSuperAgentConfig(result)).not.toThrow()
    expect(config).toEqual(original)
  })

  it('uses standard and expert models by role, works without TokenNest, and falls back to a single model', () => {
    const provider = { ...tokenNest, oauthProvider: undefined, channelGroups: undefined, models: ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol'], defaultModel: 'gpt-6-astra' }
    const coding = applyPreset(createConfig([provider], text), 'coding', provider, text)
    expect(coding.nodes.map(node => node.model)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6-astra'])
    const single = { ...provider, models: ['only-model'] }
    for (const preset of SUPER_AGENT_PRESETS) {
      expect(applyPreset(coding, preset, single, text).nodes.every(node => node.model === 'only-model')).toBe(true)
    }
    expect(applyPreset(coding, 'daily', { ...provider, isAuthenticated: false }, text)).toEqual(coding)
    expect(applyPreset(coding, 'daily', { ...provider, models: ['gpt-image-1'] }, text)).toEqual(coding)
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
