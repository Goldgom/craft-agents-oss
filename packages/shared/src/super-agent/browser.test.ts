import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from './index'

test('Super Agent browser entry bundles without filesystem or crypto dependencies', async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'browser.ts')], target: 'browser' })
  expect(build.success).toBe(true)
  expect(build.logs).toHaveLength(0)
  const output = await build.outputs[0]!.text()
  expect(output).not.toContain('node:fs')
  expect(output).not.toContain('node:crypto')
  expect(output).not.toContain('loadSuperAgentDocument')
  expect(typeof loadSuperAgentDocument).toBe('function')
  expect(typeof saveSuperAgentDocument).toBe('function')
})
