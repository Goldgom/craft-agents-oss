import { z } from 'zod'

export const SuperAgentPreparationSchema = z.object({
  attemptId: z.string(), turnId: z.string(), attempt: z.number().int().min(1),
  stage: z.enum(['environment', 'session', 'policy', 'settings', 'ready']),
  status: z.enum(['preparing', 'cancelling', 'retrying', 'failed', 'completed']),
  startedAt: z.number(), stageStartedAt: z.number(), deadlineAt: z.number(),
  cleanupPending: z.boolean().optional(), warningAt: z.number().optional(), completedAt: z.number().optional(),
  error: z.string().max(2000).optional(),
}).strict()
export type SuperAgentPreparation = z.infer<typeof SuperAgentPreparationSchema>

/** Runtime-only cancellation; never serialized or passed to a model. */
export interface SuperAgentPreparationOptions { signal?: AbortSignal }

/** The caller must check the signal again before publishing any late result. */
export function awaitSuperAgentPreparation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason ?? new Error('Preparation cancelled')) }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Preparation cancelled')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
