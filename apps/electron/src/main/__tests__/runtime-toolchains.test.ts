import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRuntimeToolExecutable } from '../runtime-toolchains'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tokenbird-toolchain-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runtime toolchain path resolution', () => {
  test('accepts an executable path directly', () => {
    const root = fixture()
    const executable = join(root, 'node.exe')
    writeFileSync(executable, '')
    expect(resolveRuntimeToolExecutable('node', executable)).toBe(executable)
  })

  test('resolves a JDK home directory to bin/java.exe', () => {
    const root = fixture()
    mkdirSync(join(root, 'bin'))
    const executable = join(root, 'bin', 'java.exe')
    writeFileSync(executable, '')
    expect(resolveRuntimeToolExecutable('java', root)).toBe(executable)
  })

  test('rejects a directory without the requested runtime', () => {
    const root = fixture()
    expect(resolveRuntimeToolExecutable('python', root)).toBeUndefined()
  })
})
