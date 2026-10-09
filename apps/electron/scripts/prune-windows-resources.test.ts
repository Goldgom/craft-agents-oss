import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import pruneWindowsResources from './prune-windows-resources.cjs'

const temporaryRoots: string[] = []
const retainedFiles = [
  'resources/vendor/bun/bun.exe',
  'resources/app/resources/bin/win32-x64/uv.exe',
  'resources/app/resources/bin/pdf-tool.cmd',
  'resources/app/resources/bridge-mcp-server/index.js',
  'resources/app/resources/session-mcp-server/index.js',
  'resources/app/resources/pi-agent-server/index.js',
  'resources/app/vendor/git-bash/bin/bash.exe',
  'resources/app/vendor/git-bash/cmd/git.exe',
  'resources/app/vendor/git-bash/usr/bin/sed.exe',
  'resources/app/vendor/toolchains/jdk/bin/java.exe',
  'resources/app/vendor/toolchains/jdk/bin/javac.exe',
  'resources/app/vendor/toolchains/jdk/lib/modules',
  'resources/app/vendor/toolchains/python/python.exe',
  'resources/app/vendor/toolchains/python/Scripts/pip.cmd',
  'resources/app/vendor/toolchains/python/Lib/site-packages/pip/__init__.py',
  'resources/app/vendor/toolchains/node/node.exe',
  'resources/app/vendor/toolchains/node/npm.cmd',
  'resources/app/vendor/toolchains/node/node_modules/npm/bin/npm-cli.js',
]
const redundantFiles = [
  'resources/app/vendor/bun/bun.exe',
  'resources/app/vendor/bun/bun',
  'resources/app/dist/resources/bin/win32-x64/uv.exe',
  'resources/app/dist/resources/bin/linux-x64/uv',
  'resources/app/dist/resources/bridge-mcp-server/index.js',
  'resources/app/dist/resources/session-mcp-server/index.js',
  'resources/app/dist/resources/pi-agent-server/index.js',
  'resources/app/resources/bin/linux-arm64/uv',
  'resources/app/resources/bin/darwin-x64/uv',
  'resources/app/resources/bin/win32-arm64/uv.exe',
]

function packagedWindowsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tokenbird-package-prune-'))
  temporaryRoots.push(root)
  for (const file of [...retainedFiles, ...redundantFiles]) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file)
  }
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows packaged runtimes', () => {
  test('removes redundant copies and preserves complete runnable tool distributions', async () => {
    const root = packagedWindowsFixture()
    const context = { electronPlatformName: 'win32', appOutDir: root }
    await pruneWindowsResources(context)
    await pruneWindowsResources(context)

    for (const file of retainedFiles) expect(readFileSync(join(root, file), 'utf8')).toBe(file)
    for (const file of redundantFiles) expect(existsSync(join(root, file))).toBe(false)
  }, 15000)

  test('refuses to prune if the canonical Bun runtime is missing', async () => {
    const root = packagedWindowsFixture()
    rmSync(join(root, 'resources/vendor/bun/bun.exe'))
    await expect(pruneWindowsResources({ electronPlatformName: 'win32', appOutDir: root }))
      .rejects.toThrow('Required Windows runtime missing')
    for (const file of redundantFiles) expect(existsSync(join(root, file))).toBe(true)
  })

  test('rejects redirected directories before removing any files', async () => {
    const root = packagedWindowsFixture()
    const redirected = join(root, 'resources/app/dist/resources/bin')
    rmSync(redirected, { recursive: true })
    symlinkSync(join(root, 'resources/app/resources/bin'), redirected, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(pruneWindowsResources({ electronPlatformName: 'win32', appOutDir: root }))
      .rejects.toThrow('Refusing to prune redirected Windows resource')
    for (const file of retainedFiles) expect(readFileSync(join(root, file), 'utf8')).toBe(file)
    expect(existsSync(join(root, 'resources/app/vendor/bun/bun.exe'))).toBe(true)
  })
})
