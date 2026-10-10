import type { SessionEvent } from '@craft-agent/shared/protocol'

export interface BirdCompanionPreferences {
  alwaysVisible: boolean
  autoShowComputerUse: boolean
}

export const DEFAULT_BIRD_COMPANION_PREFERENCES: BirdCompanionPreferences = {
  alwaysVisible: false,
  autoShowComputerUse: true,
}

export const BIRD_COMPANION_IPC = {
  getPreferences: 'bird-companion:get-preferences',
  setPreferences: 'bird-companion:set-preferences',
  observe: 'bird-companion:observe',
  state: 'bird-companion:state',
  getState: 'bird-companion:get-state',
  ready: 'bird-companion:ready',
  dismissBubble: 'bird-companion:dismiss-bubble',
  showBubble: 'bird-companion:show-bubble',
  resizeBubble: 'bird-companion:resize-bubble',
  interactive: 'bird-companion:interactive',
  move: 'bird-companion:move',
} as const

export type BirdMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'success' | 'error' | 'interrupted'
export type BirdWindowRole = 'bird' | 'bubble'
export interface BirdCompanionState {
  visible: boolean
  bubbleVisible: boolean
  mood: BirdMood
  /** Translation suffix, never tool inputs, credentials, or raw model output. */
  activity: string
  completedSteps: number
  activeSessions: number
  language?: string
}

export const IDLE_BIRD_STATE: BirdCompanionState = {
  visible: false, bubbleVisible: false, mood: 'idle', activity: 'idle', completedSteps: 0, activeSessions: 0,
}

export type BirdProgressEvent =
  | { type: 'start'; sessionId: string; startId: string }
  | { type: 'tool'; sessionId: string; toolUseId: string; activity: string; computer: boolean }
  | { type: 'result'; sessionId: string; toolUseId: string; isError: boolean }
  | { type: 'permission'; sessionId: string; requestId: string; computer: boolean }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; allowed: boolean }
  | { type: 'finish'; sessionId: string; outcome: 'complete' | 'error' | 'interrupted' }
  | { type: 'delete'; sessionId: string }

const COMPUTER_ACTIONS = new Set([
  'status', 'windows', 'snapshot', 'focus', 'screenshot', 'position', 'move', 'click',
  'drag', 'scroll', 'type', 'key', 'wait', 'help',
])

function toolActivity(name: string, input: Record<string, unknown> = {}): { activity: string; computer: boolean } {
  // Handles MCP-qualified and native tool names without matching arbitrary prose.
  const computer = /(?:^|__)computer_use$/.test(name) || /^(?:computer|computer_use)$/.test(name)
  if (computer) {
    const action = typeof input.action === 'string' && COMPUTER_ACTIONS.has(input.action) ? input.action : 'computer'
    return { activity: action, computer: true }
  }
  const command = input.command
  if (/^(?:Bash|bash|shell|Shell)$/.test(name) && typeof command === 'string'
    && /(?:^|[\s"'\\/])desktop-control(?:\.cmd|\.exe)?(?:[\s"']|$)/i.test(command)) {
    return { activity: 'computer', computer: true }
  }
  if (/(?:^|__)browser(?:_|$)/i.test(name)) return { activity: 'browser', computer: false }
  if (/search|WebFetch/i.test(name)) return { activity: 'search', computer: false }
  if (/write|edit|patch/i.test(name)) return { activity: 'editing', computer: false }
  if (/read|glob|grep/i.test(name)) return { activity: 'reading', computer: false }
  if (/bash|shell/i.test(name)) return { activity: 'shell', computer: false }
  return { activity: 'working', computer: false }
}

/** Strip the event to progress metadata before it crosses the companion boundary. */
export function toBirdProgressEvent(event: SessionEvent): BirdProgressEvent | null {
  switch (event.type) {
    case 'user_message': return event.status !== 'queued' ? { type: 'start', sessionId: event.sessionId, startId: event.message.id } : null
    case 'tool_start': return { type: 'tool', sessionId: event.sessionId, toolUseId: event.toolUseId, ...toolActivity(event.toolName, event.toolInput) }
    case 'tool_result': return { type: 'result', sessionId: event.sessionId, toolUseId: event.toolUseId, isError: !!event.isError }
    case 'permission_request': return { type: 'permission', sessionId: event.sessionId, requestId: event.request.requestId, computer: toolActivity(event.request.toolName, { command: event.request.command }).computer }
    case 'permission_resolved': return { type: 'permission_resolved', sessionId: event.sessionId, requestId: event.requestId, allowed: event.allowed }
    case 'complete': return { type: 'finish', sessionId: event.sessionId, outcome: 'complete' }
    case 'error': case 'typed_error': return { type: 'finish', sessionId: event.sessionId, outcome: 'error' }
    case 'interrupted': return { type: 'finish', sessionId: event.sessionId, outcome: 'interrupted' }
    case 'session_deleted': return { type: 'delete', sessionId: event.sessionId }
    default: return null
  }
}
