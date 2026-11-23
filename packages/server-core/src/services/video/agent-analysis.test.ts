import { describe, expect, test } from 'bun:test'
import type { ISessionManager } from '../../handlers/session-manager-interface'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import type { VideoAnalysisInput } from '@tokenbird/shared/video'
import { createVideoAnalyzer, parseVideoAnalysis } from './agent-analysis'

const reply = { memories: [{ kind: 'person', name: '小林', description: '穿蓝色外套的人物' }], shots: [{ title: '走进公园', prompt: '中景，人物走进晨雾中的公园', durationSeconds: 5, memoryIds: [], memoryNames: ['小林'] }] }
const input: VideoAnalysisInput = { workspaceId: 'workspace', project: { id: 'project', name: '晨间', script: '小林走进公园。', preferences: '自然光', aspectRatio: '16:9', memoryIds: [], shots: [], createdAt: 1, updatedAt: 1 }, memories: [], connectionSlug: 'chosen-connection', model: 'chosen-model' }

describe('video storyboard Agent', () => {
  test('validates structured results rather than guessing shots from arbitrary model prose', () => {
    expect(parseVideoAnalysis(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``).shots[0]!.durationSeconds).toBe(5)
    expect(() => parseVideoAnalysis('I have completed your video.')).toThrow('valid storyboard')
    expect(() => parseVideoAnalysis(JSON.stringify({ memories: [], shots: [] }))).toThrow('valid storyboard')
  })
  test('runs the selected actual session runtime and subscribes before dispatch', async () => {
    let listener: ((event: SessionCompletionEvent) => void) | undefined
    let settings: unknown; let prompt = ''; let unsubscribed = false
    const manager = {
      createSession: async (_workspace: string, options: unknown) => { settings = options; return { id: 'analysis-session' } },
      onSessionComplete: (fn: typeof listener) => { listener = fn; return () => { unsubscribed = true } },
      sendMessage: async (id: string, message: string) => { prompt = message; listener!({ sessionId: id, workspaceId: 'workspace', reason: 'complete', finalText: JSON.stringify(reply) }) },
      getSessionFinalText: () => undefined,
      cancelProcessing: async () => {},
    } as unknown as ISessionManager
    const result = await createVideoAnalyzer(manager)(input, new AbortController().signal)
    expect(settings).toMatchObject({ llmConnection: 'chosen-connection', model: 'chosen-model', permissionMode: 'safe', enabledSourceSlugs: [] })
    expect(JSON.parse(prompt).script).toBe('小林走进公园。')
    expect(result.agentSessionId).toBe('analysis-session')
    expect(result.memories[0]!.name).toBe('小林')
    expect(unsubscribed).toBe(true)
  })
  test('cancellation stops the real Agent session and removes the completion listener', async () => {
    const abort = new AbortController()
    let cancelled = ''; let removed = false
    const manager = {
      createSession: async () => ({ id: 'cancel-analysis' }),
      onSessionComplete: () => () => { removed = true },
      sendMessage: async () => { abort.abort(new Error('cancelled by user')) },
      cancelProcessing: async (id: string) => { cancelled = id },
    } as unknown as ISessionManager
    await expect(createVideoAnalyzer(manager)(input, abort.signal)).rejects.toThrow('cancelled by user')
    expect(cancelled).toBe('cancel-analysis'); expect(removed).toBe(true)
  })
})
