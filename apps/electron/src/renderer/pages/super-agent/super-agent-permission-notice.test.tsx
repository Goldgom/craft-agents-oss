import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SuperAgentConfig, SuperAgentMessage } from '@craft-agent/shared/super-agent'
import { PermissionResultCard } from './PermissionResultCard'
import { approvalNotice, permissionNotice } from './super-agent-permission-notice'
import type { SuperAgentApproval } from './super-agent-activity'

const config = { nodes: [{ id: 'worker', name: '执行助手' }] } as SuperAgentConfig
const request: SuperAgentApproval = { id: 'request', nodeId: 'worker', coordinatorId: 'main', sessionId: 'session',
  toolName: 'Bash', description: 'Run a command', status: 'approved', createdAt: 100, resolvedAt: 200,
  scope: { kind: 'program', toolName: 'Bash', target: 'client:123', operation: 'powershell <script> & run', boundary: 'client', expiresAt: 10_000 } }
const message: SuperAgentMessage = { id: 'message', fromNodeId: 'system', toNodeId: 'user', kind: 'message', createdAt: 100,
  body: '执行助手 is waiting for user permission: Run a command\nReason: Super Agent policy: tool "Bash" is not granted\nTarget (client): client:123\nRequested operation: powershell <script> & run\nThe current turn remains paused until the user approves or denies this operation.' }

describe('Approval message cards', () => {
  it('converts existing long notices to their correlated decision and preserves unrecorded history', () => {
    expect(permissionNotice(message, [request], config)?.record.status).toBe('approved')
    const archived = permissionNotice(message, [], config)!
    expect(archived.record).toMatchObject({ status: 'archived', toolName: 'Bash', target: 'client:123' })
    expect(archived.legacyDetails).toContain('powershell <script> & run')
    expect(permissionNotice({ ...message, fromNodeId: 'user' }, [], config)).toBeUndefined()
    expect(permissionNotice({ ...message, body: 'Normal system notice' }, [], config)).toBeUndefined()
  })

  it('does not assign a decision from another task, node, time or ambiguous request', () => {
    for (const inbox of [
      [{ ...request, taskId: 'different-task' }], [{ ...request, nodeId: 'other' }],
      [{ ...request, createdAt: 9_000 }], [request, { ...request, id: 'different-request' }],
    ]) expect(permissionNotice(message, inbox, config)?.record.status).toBe('archived')
  })

  it('retains durable results after the runtime inbox disappears', () => {
    for (const status of ['approved', 'denied', 'expired'] as const) {
      const notice = approvalNotice({ ...request, status })
      const saved = { ...message, body: `Permission ${status} for Bash.`, permission: notice.record as NonNullable<SuperAgentMessage['permission']> }
      expect(permissionNotice(saved, [], config)?.record).toEqual(notice.record)
    }
  })

  it('keeps commands in a closed disclosure, escapes command text and has no approval buttons', () => {
    const html = renderToStaticMarkup(<PermissionResultCard notice={approvalNotice(request)} owner="执行助手" timestamp="12:49" text={key => key} />)
    const summary = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)![1]
    expect(summary).toContain('approved')
    expect(summary).toContain('执行助手')
    expect(summary).toContain('Bash · client:123')
    expect(summary).not.toContain('powershell')
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/)
    expect(html).toContain('powershell &lt;script&gt; &amp; run')
    expect(html).not.toContain('<button')
  })
})
