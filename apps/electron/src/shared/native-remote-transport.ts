import type { TransportConnectionState } from '@craft-agent/server-core/transport'

/** Native Electron only. None of these channels belongs to the network RPC server. */
export const NATIVE_REMOTE_TRANSPORT = {
  OPEN: '__remoteWorkspaceTransport:open',
  START: '__remoteWorkspaceTransport:start',
  INVOKE: '__remoteWorkspaceTransport:invoke',
  SUBSCRIBE: '__remoteWorkspaceTransport:subscribe',
  RECONNECT: '__remoteWorkspaceTransport:reconnect',
  CAPABILITY_RESULT: '__remoteWorkspaceTransport:capabilityResult',
  DESTROY: '__remoteWorkspaceTransport:destroy',
  EVENT: '__remoteWorkspaceTransport:event',
} as const
export type NativeRemoteMode = 'workspace' | 'thin'
export type NativeRemoteFailureCode = 'DENIED' | 'EXPIRED' | 'TARGET_CHANGED' | 'LIMIT' | 'FAILED'
export type NativeRemoteResult<T> = { ok: true; value: T } | { ok: false; code: NativeRemoteFailureCode; message: string }
export interface NativeRemoteOpened {
  handle: string
  state: TransportConnectionState
  availableChannels: string[]
  remoteWorkspaceId?: string
}
export type NativeRemotePacket =
  | { kind: 'state'; handle: string; state: TransportConnectionState; availableChannels: string[] }
  | { kind: 'push'; handle: string; channel: string; args: unknown[] }
  | { kind: 'capability'; handle: string; callId: string; channel: string; args: unknown[] }
export type NativeRemoteCapabilityResult = { ok: true; value: unknown } | { ok: false; message?: string }
