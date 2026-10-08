import { z } from 'zod'

/** Keep rejected field paths and their repair instructions ahead of verbose data. */
export function superAgentActionErrorMessage(error: unknown): string {
  if (!(error instanceof z.ZodError)) return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)

  const fields = new Set(error.issues.map(issue => issue.path[0]))
  const hints: string[] = []
  if (fields.has('tasks') || fields.has('messages')) {
    hints.push('tasks entries require title and instructions; optional nodeId and planId. messages entries require toNodeId and body. Put message-shaped entries in messages, not tasks. For an assignment, supply title/instructions/nodeId; do not invent missing task requirements.')
  }
  const issues = error.issues.slice(0, 6).map(issue => {
    const path = issue.path.reduce<string>((value, part) => typeof part === 'number'
      ? `${value}[${part}]` : `${value}${value ? '.' : ''}${String(part)}`, '') || 'actions'
    return `${path}: ${issue.message}`
  })
  if (error.issues.length > 6) issues.push(`${error.issues.length - 6} additional validation errors; validate every entry before resubmitting.`)
  return [...hints, ...issues].join('\n').slice(0, 2_000)
}
