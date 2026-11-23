import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSessionExecutionPolicy, setSessionExecutionPolicy } from '@tokenbird/shared/agent'
import { runVideoSessionTool } from './session-tool'
import { VideoService } from './service'
import type { VideoJob, VideoProject } from '@tokenbird/shared/video'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tokenbird-video-bridge-')) })
afterEach(async () => { clearSessionExecutionPolicy('video-session-bridge'); await rm(directory, { recursive: true, force: true }) })

test('host bridge imports an actual media file into the scoped asset service without shell or arbitrary destination', async () => {
  await writeFile(join(directory, 'reference.png'), Buffer.from([137, 80, 78, 71]))
  let request: unknown
  const result = await runVideoSessionTool('workspace', 'plain-chat', { action: 'import_asset', args: { path: 'reference.png', outputPath: 'ignored-outside' } }, {
    workingDirectory: directory,
    service: { execute: async (workspace, action, args) => { request = { workspace, action, args }; return { id: 'asset' } } },
  })
  expect(result).toEqual({ id: 'asset' })
  expect(request).toEqual({ workspace: 'workspace', action: 'import_asset', args: { name: 'reference.png', mimeType: 'image/png', bytesBase64: Buffer.from([137, 80, 78, 71]).toString('base64') } })
})

test('model asset reads return metadata instead of embedding video bytes in context', async () => {
  const asset = { id: 'asset', name: 'film.mp4', path: join(directory, 'film.mp4') }
  const result = await runVideoSessionTool('workspace', 'plain-chat', { action: 'read_asset', args: { assetId: 'asset' } }, {
    workingDirectory: directory, service: { execute: async (_workspace, action) => { expect(action).toBe('state'); return { assets: [asset] } } },
  })
  expect(result).toEqual(asset)
})

test('worker bridge cannot launch script analysis indirectly when the project has no storyboard', async () => {
  setSessionExecutionPolicy('video-session-bridge', { nodeId: 'worker', role: 'worker', rootPath: directory, fullControl: true, readFiles: false, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false })
  let dispatched = false
  const options = { workingDirectory: directory, service: { execute: async (_workspace: string, action: unknown) => { if (action === 'state') return { projects: [{ id: 'project', shots: [] }] }; dispatched = true; return {} } } }
  await expect(runVideoSessionTool('workspace', 'video-session-bridge', { action: 'generate_project', args: { projectId: 'project' } }, options)).rejects.toThrow('current model turn')
  await expect(runVideoSessionTool('workspace', 'video-session-bridge', { action: 'generate_project', args: { projectId: 'project', analyzeFirst: true } }, options)).rejects.toThrow('additional script analysis')
  expect(dispatched).toBe(false)
})

test('the real background service cannot launch an Agent when a storyboard disappears after the worker bridge precheck', async () => {
  setSessionExecutionPolicy('video-session-bridge', { nodeId: 'worker', role: 'worker', rootPath: directory, fullControl: true, readFiles: false, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false })
  let analyzed = 0; let cleared = false
  const service = new VideoService({ resolveWorkspace: id => ({ id, rootPath: directory }), analyzer: async () => { analyzed++; return { memories: [], shots: [{ title: 'Unexpected', prompt: 'Must never run', durationSeconds: 5, memoryIds: [] }] } } })
  const project = await service.execute('workspace', 'save_project', { name: 'Concurrent project', script: 'A scene', shots: [{ title: 'Exists at precheck', prompt: 'A scene', durationSeconds: 5 }] }) as VideoProject
  const job = await runVideoSessionTool('workspace', 'video-session-bridge', { action: 'generate_project', args: { projectId: project.id, allowAgentAnalysis: true, hostContext: { allowAgentAnalysis: true } } }, {
    workingDirectory: directory,
    service: {
      execute: async (workspace, action, args, context) => {
        const result = await service.execute(workspace, action, args, context)
        if (action === 'state' && !cleared) { cleared = true; await service.execute('workspace', 'save_project', { id: project.id, shots: [] }) }
        if (action === 'generate_project') expect(context?.allowAgentAnalysis).toBe(false)
        return result
      },
    },
  }) as VideoJob
  let result = job
  for (let i = 0; i < 100; i++) {
    result = await service.execute('workspace', 'job', { jobId: job.id }) as VideoJob
    if (!['running', 'queued'].includes(result.status)) break
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  expect(cleared).toBe(true)
  expect(result.status).toBe('failed')
  expect(result.error).toContain('cannot launch an additional Agent')
  expect(analyzed).toBe(0)
})
