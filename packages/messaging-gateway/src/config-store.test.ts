import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigStore } from './config-store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('ConfigStore command settings', () => {
  it('persists command aliases and custom messages without replacing platform config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'messaging-config-'))
    dirs.push(dir)
    const store = new ConfigStore(dir)
    store.update({ enabled: true, platforms: { telegram: { enabled: true } } })
    store.update({
      commands: {
        commands: { new: { enabled: true, aliases: ['start', 'create'] } },
        helpMessage: 'Custom {commands}',
        unknownCommandBehavior: 'ignore',
      },
    })

    const reloaded = new ConfigStore(dir).get()
    expect(reloaded.platforms.telegram?.enabled).toBe(true)
    expect(reloaded.commands?.commands?.new?.aliases).toEqual(['start', 'create'])
    expect(reloaded.commands?.helpMessage).toBe('Custom {commands}')
    expect(reloaded.commands?.unknownCommandBehavior).toBe('ignore')
  })
})
