import { describe, expect, it, mock } from 'bun:test'
import { createServerSwitcher } from './server-switch'
import type { ResolvedRemoteProfile } from './remote-credentials'

const profile = (id: string): ResolvedRemoteProfile => ({
  id, profileId: id, name: id, url: `wss://${id}.example.test`,
  token: 'saved-secret', revision: `revision-${id}`, createdAt: 1, updatedAt: 1,
})

function fixture(localRunning = true) {
  const env: NodeJS.ProcessEnv = { CRAFT_WORKSPACE_ID: 'old-workspace' }
  let remote: ResolvedRemoteProfile | undefined
  let mode = 'local'
  const reloadWindows = mock(() => {})
  const restart = mock(() => {})
  const persistLocation = mock((_target: string) => {})
  const resolveProfile = mock(async (id: string) => id === 'missing' ? undefined : profile(id))
  const switchServer = createServerSwitcher({
    env, resolveProfile, persistLocation, reloadWindows, restart,
    canReload: target => target !== 'local' || localRunning,
    setContext: (target, next) => { mode = target; remote = next },
  })
  return { env, switchServer, reloadWindows, restart, persistLocation, resolveProfile, context: () => ({ mode, remote }) }
}

describe('runtime server switching', () => {
  it('keeps the local host alive through remote, remote, picker, and local switches', async () => {
    const f = fixture()
    for (const target of ['remote-a', 'remote-b', 'none', 'local']) await f.switchServer(target)
    expect(f.restart).not.toHaveBeenCalled()
    expect(f.reloadWindows).toHaveBeenCalledTimes(4)
    expect(f.context()).toEqual({ mode: 'local', remote: undefined })
    expect(f.env.CRAFT_SERVER_URL).toBeUndefined()
    expect(f.env.CRAFT_SERVER_PROFILE_ID).toBeUndefined()
    expect(f.env.CRAFT_WORKSPACE_ID).toBeUndefined()
  })

  it('uses a main-owned credential snapshot without passing the bearer to the new renderer', async () => {
    const f = fixture()
    f.env.CRAFT_SERVER_TOKEN = 'old-ad-hoc-secret'
    await f.switchServer('remote-a')
    expect(f.env.CRAFT_SERVER_URL).toBe(profile('remote-a').url)
    expect(f.env.CRAFT_SERVER_PROFILE_ID).toBe('remote-a')
    expect(f.env.CRAFT_SERVER_TOKEN).toBeUndefined()
    expect(f.context().remote?.token).toBe('saved-secret')
    expect(f.context().remote?.revision).toBe('revision-remote-a')
  })

  it('leaves the current server untouched if profile resolution fails', async () => {
    const f = fixture()
    await expect(f.switchServer('missing')).rejects.toThrow('Remote server profile not found')
    expect(f.env.CRAFT_WORKSPACE_ID).toBe('old-workspace')
    expect(f.persistLocation).not.toHaveBeenCalled()
    expect(f.reloadWindows).not.toHaveBeenCalled()
    expect(f.restart).not.toHaveBeenCalled()
  })

  it('rejects a request from a frame that navigated during credential resolution', async () => {
    const f = fixture()
    let current = true
    f.resolveProfile.mockImplementation(async id => { current = false; return profile(id) })
    await expect(f.switchServer('remote-a', () => {
      if (!current) throw new Error('expired frame')
    })).rejects.toThrow('expired frame')
    expect(f.persistLocation).not.toHaveBeenCalled()
    expect(f.reloadWindows).not.toHaveBeenCalled()
    expect(f.env.CRAFT_SERVER_URL).toBeUndefined()
  })

  it('orders overlapping requests and continues after a rejected request', async () => {
    const f = fixture()
    const results = await Promise.allSettled([
      f.switchServer('remote-a'), f.switchServer('missing'), f.switchServer('remote-b'),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(f.persistLocation.mock.calls.map(args => args[0])).toEqual(['remote-a', 'remote-b'])
    expect(f.context().remote?.id).toBe('remote-b')
    expect(f.restart).not.toHaveBeenCalled()
  })

  it('boots a local service when none exists, while remote switches only reload', async () => {
    const f = fixture(false)
    await f.switchServer('remote-a')
    expect(f.restart).not.toHaveBeenCalled()
    await f.switchServer('local')
    expect(f.restart).toHaveBeenCalledTimes(1)
    expect(f.env.CRAFT_SERVER_URL).toBeUndefined()
  })
})
