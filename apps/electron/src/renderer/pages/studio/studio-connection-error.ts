import { STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE, STUDIO_TOKENNEST_REAUTH_REQUIRED } from '@craft-agent/shared/protocol'

export type StudioConnectionIssue = 'reauth' | 'channel'

/** Only TokenNest OAuth errors should interrupt the canvas with connection recovery. */
export function classifyStudioConnectionError(error: unknown, isTokenNestOAuth: boolean): StudioConnectionIssue | null {
  if (!isTokenNestOAuth) return null
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(STUDIO_TOKENNEST_REAUTH_REQUIRED) || /TokenNest login expired|TokenNest 登录已失效/i.test(message)) return 'reauth'
  if (message.includes(STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE) || /无可用渠道|no available channel|no_available_channel/i.test(message)) return 'channel'
  return null
}
