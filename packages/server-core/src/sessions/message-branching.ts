import type { StoredMessage } from '@craft-agent/core/types'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

export const MAX_MESSAGE_BRANCHES = 10

/** Copy only files referenced by retained attachments, including converted documents. */
export async function copyBranchAttachmentFiles(messages: StoredMessage[], sourceDir: string, branchDir: string) {
  const paths = new Set(messages.flatMap(m => (m.attachments ?? []).flatMap(a =>
    [a.storedPath, a.thumbnailPath, a.markdownPath].filter((path): path is string => !!path))))
  for (const path of paths) {
    const childPath = relative(sourceDir, path)
    if (childPath === '..' || childPath.startsWith('../') || childPath.startsWith('..\\') || isAbsolute(childPath)) continue
    const destination = join(branchDir, childPath)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(path, destination)
  }
}

/** Serialize creation at a shared message node, including copies in other branches. */
export class MessageBranchGate {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, count: () => number, create: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.tails.set(key, tail)
    await previous
    try {
      if (count() >= MAX_MESSAGE_BRANCHES) throw new Error('MESSAGE_BRANCH_LIMIT: A message can have at most 10 branches.')
      return await create()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

/** Changed messages get their own identity; later parent messages never enter the child. */
export function editedBranchMessages(messages: StoredMessage[], index: number, content: string, id: string): StoredMessage[] {
  const original = messages[index]
  if (!original || (original.type !== 'user' && original.type !== 'assistant') || original.hidden || original.isQueued || original.isIntermediate) {
    throw new Error('Only completed user or assistant messages can be edited.')
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('Edited message cannot be empty.')
  return [...messages.slice(0, index), {
    ...original,
    id,
    content,
    // Text offsets and annotation targets refer to the original message.
    badges: undefined,
    annotations: undefined,
    turnId: undefined,
    relayDelivery: undefined,
    isQueued: original.type === 'user',
  }]
}

/** The last user message is sent as the current prompt, outside the seed transcript. */
export function branchSeedMessages(messages: Array<{ role: string; content: string; isIntermediate?: boolean; hidden?: boolean }>) {
  const history = messages.at(-1)?.role === 'user' ? messages.slice(0, -1) : messages
  return history.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate && !m.hidden)
    .map(m => ({ type: m.role as 'user' | 'assistant', content: m.content }))
}
