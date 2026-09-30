import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPagesMcpExecutor } from '../mcp-executor.ts'
import { PageActionBroker } from '../../../../shared/src/pages/action-bridge.ts'
import { mcpRuntimeLimiter } from '../../../../shared/src/mcp/runtime-limiter.ts'
import { config, ControllablePool } from '../../../../shared/src/mcp/__tests__/fixtures/pool-race-harness.ts'

test('five authorized page actions share one same-source handshake without weakening grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pages-mcp-ownership-'))
  const pool = new ControllablePool('read_dummy')
  let builds = 0
  const executor = createPagesMcpExecutor({
    workspaceRootPath: directory,
    pool,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    loadSources: () => [{ config: { slug: 'race', type: 'mcp', enabled: true, isAuthenticated: true, mcp: { authType: 'none' } } }] as never,
    refreshManager: { ensureFreshToken: async () => ({ success: true }) } as never,
    buildServers: async () => {
      builds++
      // Production builds fresh objects for each action, even with no rotation.
      return { mcpServers: { race: config('unchanged') }, apiServers: {}, errors: [] } as never
    },
  })
  const now = Date.now()
  const digest = 'a'.repeat(64)
  const broker = new PageActionBroker({
    executors: { executeMcp: executor },
    auditLogPath: join(directory, 'audit.jsonl'),
    now: () => now,
  })
  const page = {
    schemaVersion: 1, id: 'page_probe00001', slug: 'probe', name: 'Probe', kind: 'interactive', createdAt: now, updatedAt: now, contentDigest: digest,
    grants: [{ id: 'grant_probe0001', action: { kind: 'mcp', sourceSlug: 'race', toolName: 'read_dummy' }, contentDigest: digest, createdAt: now, expiresAt: now + 60_000 }],
  } as never
  const lease = broker.createLease({ pageSlug: 'probe', contentDigest: digest })
  const request = (id: string) => ({
    requestId: id, pageSlug: 'probe', leaseId: lease.leaseId, nonce: lease.nonce, grantId: 'grant_probe0001',
    invocation: { kind: 'mcp' as const, toolName: 'read_dummy', args: {} },
  })
  const pending: Array<ReturnType<typeof broker.executeAction>> = []
  try {
    const denied = await broker.executeAction(page, { ...request('req_denied'), grantId: 'grant_unknown00' })
    expect(denied.ok).toBe(false)
    expect(builds).toBe(0)
    expect(pool.records).toHaveLength(0)
    for (let index = 0; index < 5; index++) pending.push(broker.executeAction(page, request(`req_concurrent_${index}`)))
    await pool.started(1)
    // Let all five independent source builds reach the real ensureConnected.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(builds).toBe(5)
    expect(pool.records).toHaveLength(1)
    pool.records[0]!.gate.resolve()
    const results = await Promise.all(pending)
    expect(results.every(result => result.ok)).toBe(true)
    expect(results.map(result => result.body)).toEqual(Array(5).fill('client_0'))
    expect(pool.records[0]!.calls).toHaveLength(5)
    expect(pool.records[0]!.closes).toBe(0)
    expect(pool.isConnected('race')).toBe(true)
  } finally {
    pool.releaseAll()
    await Promise.allSettled(pending)
    await pool.disconnectAll()
    await rm(directory, { recursive: true, force: true })
  }
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  expect(mcpRuntimeLimiter.getQueuedCount()).toBe(0)
})
