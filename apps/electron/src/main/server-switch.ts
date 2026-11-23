import { RemoteCredentialUnavailableError, type ResolvedRemoteProfile } from './remote-credentials'
import type { ServerSwitchResult } from '../shared/types'

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
  return (target: string, assertCurrent: () => void = () => {}): Promise<ServerSwitchResult> => {
    const operation = tail.then(async (): Promise<ServerSwitchResult> => {
      assertCurrent()
      let profile: ResolvedRemoteProfile | undefined
      if (target !== 'local' && target !== 'none') {
        try { profile = await deps.resolveProfile(target) }
        catch (error) {
          assertCurrent()
          if (error instanceof RemoteCredentialUnavailableError) {
            return { success: false, needsCredentialRepair: true, missingCredential: error.field }
          }
          throw error
        }
      }
      if (target !== 'local' && target !== 'none' && !profile) throw new Error('Remote server profile not found')
      assertCurrent()
      deps.persistLocation(target)
      // A workspace selection belongs to one server only. Saved credentials
      // stay in main and never become part of a renderer/subprocess environment.
      delete deps.env.TOKENBIRD_WORKSPACE_ID
      delete deps.env.TOKENBIRD_SERVER_TOKEN
      if (profile) {
        deps.env.TOKENBIRD_SERVER_URL = profile.url
        deps.env.TOKENBIRD_SERVER_PROFILE_ID = profile.id
        deps.env.TOKENBIRD_SERVER_PROFILE_NAME = profile.name
      } else {
        delete deps.env.TOKENBIRD_SERVER_URL
        delete deps.env.TOKENBIRD_SERVER_PROFILE_ID
        delete deps.env.TOKENBIRD_SERVER_PROFILE_NAME
      }
      deps.setContext(target, profile)
      if (deps.canReload(target)) deps.reloadWindows()
      else deps.restart()
      return { success: true }
    })
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}
