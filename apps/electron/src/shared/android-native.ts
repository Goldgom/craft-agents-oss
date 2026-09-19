export type AndroidPermissionKey =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'photos'
  | 'videos'
  | 'audio'
  | 'location'
  | 'contacts'
  | 'calendar'

export interface AndroidPermissionEntry {
  key: AndroidPermissionKey
  status: 'granted' | 'denied'
}

export interface AndroidPermissionSnapshot {
  permissions: AndroidPermissionEntry[]
}

export interface NetworkAdbConfig {
  enabled: boolean
  host: string
  port: number
  requiresSystemPairing: boolean
}

export interface AndroidNativeResult<T = unknown> {
  requestId: string
  success: boolean
  errorCode?: string
  error?: string
  result?: T
}

export interface AndroidBridge {
  reload: () => void
  configureServer: () => void
  dismissKeyboard: () => void
  getOAuthCallbackUrl: () => string
  openTokenNestOAuth: (url: string) => void
  getPermissionSnapshot: () => string
  requestPermission: (requestId: string, permission: AndroidPermissionKey, reason: string) => void
  openApplicationSettings: () => void
  getNetworkAdbConfig: () => string
  setNetworkAdbConfig: (host: string, port: number, enabled: boolean) => string
  openWirelessDebuggingSettings: () => void
  testNetworkAdb: (requestId: string) => void
  runNetworkAdbCommand: (requestId: string, command: string, reason: string) => void
}

declare global {
  interface Window {
    CraftAgentAndroid?: AndroidBridge
  }
}

export function parseAndroidJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function invokeAndroidNative<T>(
  eventName: 'craft-agent:android-permission-result' | 'craft-agent:android-adb-result',
  invoke: (requestId: string) => void,
  timeoutMs = 130_000,
): Promise<T> {
  const requestId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener(eventName, onResult)
      reject(new Error('Android confirmation timed out'))
    }, timeoutMs)

    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<AndroidNativeResult<T>>).detail
      if (detail?.requestId !== requestId) return
      window.clearTimeout(timeout)
      window.removeEventListener(eventName, onResult)
      if (!detail.success) {
        const error = new Error(detail.error ?? 'Android request failed') as Error & { code?: string }
        error.code = detail.errorCode
        reject(error)
        return
      }
      resolve(detail.result as T)
    }

    window.addEventListener(eventName, onResult)
    try {
      invoke(requestId)
    } catch (error) {
      window.clearTimeout(timeout)
      window.removeEventListener(eventName, onResult)
      reject(error)
    }
  })
}
