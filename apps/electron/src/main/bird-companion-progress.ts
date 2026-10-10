import {
  DEFAULT_BIRD_COMPANION_PREFERENCES, IDLE_BIRD_STATE,
  type BirdCompanionPreferences, type BirdCompanionState, type BirdProgressEvent,
} from '../shared/bird-companion'

interface Turn {
  computer: boolean
  startId?: string
  tools: Map<string, { done: boolean; activity: string }>
  permissions: Set<string>
  seenPermissions: Set<string>
  completed: number
  hadError: boolean
  activity: string
  outcome?: 'complete' | 'error' | 'interrupted'
  expired?: boolean
  sequence: number
}

/** No Electron dependency: manages concurrent turns, duplicate delivery, and dismissal. */
export class BirdCompanionProgress {
  preferences: BirdCompanionPreferences = { ...DEFAULT_BIRD_COMPANION_PREFERENCES }
  private turns = new Map<string, Turn>()
  private sequence = 0
  private bubbleDismissed = false
  private greeting = false

  setPreferences(preferences: BirdCompanionPreferences): void {
    this.preferences = preferences
    this.bubbleDismissed = false
    this.greeting = false
  }

  dismissBubble(): void {
    this.bubbleDismissed = true
    this.greeting = false
  }

  showBubble(): void {
    this.bubbleDismissed = false
    this.greeting = true
  }

  observe(workspaceId: string, event: BirdProgressEvent): boolean {
    const key = JSON.stringify([workspaceId, event.sessionId])
    let turn = this.turns.get(key)
    if (event.type === 'delete') { this.turns.delete(key); return true }
    if (event.type === 'permission' && turn?.seenPermissions.has(event.requestId)) return false
    if (event.type === 'start' || (!turn && (event.type === 'tool' || event.type === 'permission'))
      || (turn?.outcome && (event.type === 'tool' && !turn.tools.has(event.toolUseId) || event.type === 'permission'))) {
      if (event.type === 'start' && turn?.startId === event.startId) return false
      turn = { startId: event.type === 'start' ? event.startId : undefined, computer: false, tools: new Map(), permissions: new Set(), seenPermissions: new Set(), completed: 0, hadError: false, activity: 'thinking', sequence: ++this.sequence }
      this.turns.set(key, turn)
    }
    if (!turn) return false
    switch (event.type) {
      case 'start': break
      case 'tool':
        if (turn.tools.has(event.toolUseId)) return false
        if (event.computer && !turn.computer) this.bubbleDismissed = false
        turn.tools.set(event.toolUseId, { done: false, activity: event.activity })
        turn.computer ||= event.computer
        turn.activity = event.activity
        break
      case 'result':
        if (!turn.tools.has(event.toolUseId) || turn.tools.get(event.toolUseId)!.done) return false
        turn.tools.get(event.toolUseId)!.done = true
        turn.completed++
        turn.hadError ||= event.isError
        turn.activity = event.isError ? 'stepError' : 'thinking'
        break
      case 'permission':
        if (turn.permissions.has(event.requestId)) return false
        turn.permissions.add(event.requestId)
        turn.seenPermissions.add(event.requestId)
        if (event.computer && !turn.computer) this.bubbleDismissed = false
        turn.computer ||= event.computer
        break
      case 'permission_resolved':
        if (!turn.permissions.delete(event.requestId)) return false
        turn.activity = event.allowed ? 'thinking' : 'denied'
        turn.hadError ||= !event.allowed
        break
      case 'finish':
        // Errors/interruption can precede the finally-block complete event.
        if (turn.outcome) return false
        turn.outcome = event.outcome
        turn.permissions.clear()
        if (turn.computer) this.bubbleDismissed = false
        break
    }
    this.greeting = false
    turn.sequence = ++this.sequence
    // Bound memory, keeping active turns and the most recent outcomes.
    if (this.turns.size > 100) {
      for (const [oldKey, oldTurn] of this.turns) {
        if (oldTurn.outcome && oldKey !== key) this.turns.delete(oldKey)
        if (this.turns.size <= 100) break
      }
    }
    return true
  }

  clearFinished(): void {
    for (const turn of this.turns.values()) {
      // Keep bounded history so delayed duplicate deliveries cannot revive an
      // already hidden turn. New message/tool ids still start a fresh turn.
      if (turn.outcome) turn.expired = true
    }
  }

  getState(): BirdCompanionState {
    const pinned = this.preferences.alwaysVisible
    const candidates = [...this.turns.values()]
      .filter(turn => !turn.expired && (pinned || this.preferences.autoShowComputerUse && turn.computer))
    const active = candidates.filter(turn => !turn.outcome)
    const turn = (active.length ? active : candidates).sort((a, b) => b.sequence - a.sequence)[0]
    if (!turn) return { ...IDLE_BIRD_STATE, visible: pinned, bubbleVisible: pinned && this.greeting && !this.bubbleDismissed, activity: this.greeting ? 'greeting' : 'idle' }
    let mood: BirdCompanionState['mood'] = 'thinking'
    let activity = turn.activity
    if (turn.outcome) {
      mood = turn.outcome === 'interrupted' ? 'interrupted' : turn.outcome === 'error' || turn.hadError ? 'error' : 'success'
      activity = turn.outcome === 'complete' ? turn.hadError ? 'finishedWithErrors' : 'finished' : turn.outcome
    } else if (turn.permissions.size) { mood = 'waiting'; activity = 'permission' }
    else {
      const pending = [...turn.tools.values()].filter(tool => !tool.done)
      if (pending.length) { mood = 'working'; activity = pending[pending.length - 1]!.activity }
    }
    return { visible: true, bubbleVisible: !this.bubbleDismissed, mood, activity, completedSteps: turn.completed, activeSessions: active.length }
  }
}
