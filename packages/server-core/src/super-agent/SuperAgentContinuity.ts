import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SuperAgentDocument, SuperAgentTask } from '@craft-agent/shared/super-agent'

/** Bounded streaming, realpath confinement, and a second stat avoid accepting a moving file. */
export async function fingerprintArtifact(root: string, path: string): Promise<{ path: string; sha256: string }> {
  const base = await realpath(root)
  const target = await realpath(resolve(base, path))
  const rel = relative(base, target)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Artifact must be a file inside the execution folder')
  const before = await stat(target)
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('Artifact must be a regular file up to 64 MB')
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(target)) { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw new Error('Artifact grew beyond its limit'); hash.update(chunk) }
  const after = await stat(target)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size
    || await realpath(resolve(base, path)) !== target) throw new Error('Artifact changed during verification; retry after the writer finishes')
  return { path: target, sha256: hash.digest('hex') }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as object).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export function operationFingerprint(task: SuperAgentTask | undefined, turnId: string, toolName: string, input: Record<string, unknown>): string {
  // Attempts do not change identity. A new persisted step does.
  const { _intent, _displayName, ...payload } = input
  return createHash('sha256').update(canonical([task?.id ?? turnId, task?.checkpoint?.revision ?? 0, toolName.toLowerCase(), payload])).digest('hex')
}

export function markArtifactStale(document: SuperAgentDocument, artifactId: string): void {
  const affected = new Set(document.state.tasks.filter(task => task.artifactIds?.includes(artifactId)
    || task.inputArtifacts?.some(input => input.id === artifactId)).map(task => task.id))
  let size = -1
  while (size !== affected.size) {
    size = affected.size
    for (const task of document.state.tasks) if (task.dependsOn?.some(id => affected.has(id))) affected.add(task.id)
  }
  for (const task of document.state.tasks) {
    if (!affected.has(task.id)) continue
    if (task.acceptance) task.acceptance = { ...task.acceptance, status: 'stale', note: `Artifact ${artifactId} changed; verify the current version before accepting again.` }
    const plan = document.state.plans.find(plan => plan.id === task.planId)
    if (plan?.status === 'completed') { plan.status = 'active'; plan.revision++; plan.note = `Artifact ${artifactId} changed; prior completion needs verification.` }
    const goal = document.state.intents?.find(goal => goal.id === task.goalId)
    if (goal?.status === 'delivered') goal.status = 'active'
  }
}

export function taskPriority(document: SuperAgentDocument, taskId?: string): number {
  const task = document.state.tasks.find(task => task.id === taskId)
  const plan = document.state.plans.find(plan => plan.id === task?.planId)
  const downstream = document.state.tasks.filter(other => other.dependsOn?.includes(taskId ?? '') && other.status === 'queued').length
  return (plan?.priority ?? 3) * 100 - Math.min(downstream, 50)
}
