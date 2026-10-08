import type { ResolvedRemoteProfile } from './remote-credentials'

/** Switch the frontend connection without terminating the embedded agent host. */
export function createServerSwitcher(deps: {
  env: NodeJS.ProcessEnv
  resolveProfile(id: string): Promise<ResolvedRemoteProfile | undefined>
  persistLocation(target: string): void
  setContext(target: string, profile: ResolvedRemoteProfile | undefined): void
  canReload(target: string): boolean
  reloadWindows(): void
  restart(): void
}) {
  let tail: Promise<void> = Promise.resolve()
  return (target: string, assertCurrent: () => void = () => {}): Promise<void> => {
    const operation = tail.then(async () => {
      assertCurrent()
      const profile = target === 'local' || target === 'none'
        ? undefined : await deps.resolveProfile(target)
      if (target !== 'local' && target !== 'none' && !profile) throw new Error('Remote server profile not found')
      assertCurrent()
      deps.persistLocation(target)
      // A workspace selection belongs to one server only. Saved credentials
      // stay in main and never become part of a renderer/subprocess environment.
      delete deps.env.CRAFT_WORKSPACE_ID
      delete deps.env.CRAFT_SERVER_TOKEN
      if (profile) {
        deps.env.CRAFT_SERVER_URL = profile.url
        deps.env.CRAFT_SERVER_PROFILE_ID = profile.id
        deps.env.CRAFT_SERVER_PROFILE_NAME = profile.name
      } else {
        delete deps.env.CRAFT_SERVER_URL
        delete deps.env.CRAFT_SERVER_PROFILE_ID
        delete deps.env.CRAFT_SERVER_PROFILE_NAME
      }
      deps.setContext(target, profile)
      if (deps.canReload(target)) deps.reloadWindows()
      else deps.restart()
    })
    tail = operation.catch(() => {})
    return operation
  }
}
