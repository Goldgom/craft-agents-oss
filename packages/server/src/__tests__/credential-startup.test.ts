import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SecureStorageBackend } from '@tokenbird/shared/credentials/backends/secure-storage'
import { checkServerStartupCredentials, logServerCredentialDiagnostic, ServerCredentialStartupError, type ServerCredentialDiagnostic } from '../credential-startup'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-server-startup-'))
  directories.push(directory)
  return { directory, filePath: join(directory, 'credentials.enc') }
}
const id = { type: 'anthropic_api_key' as const }

test('first launch confirms an empty vault without creating credentials or requesting input', async () => {
  const f = fixture(), events: ServerCredentialDiagnostic[] = []
  const backend = await checkServerStartupCredentials({ filePath: f.filePath, report: event => events.push(event) })
  expect(backend.getProtectionFormat()).toBe('empty')
  expect(events).toEqual([{ event: 'ready', attempt: 1 }])
  expect(existsSync(f.filePath)).toBe(false)
})

test('healthy encrypted credentials are actually read and returned without rewriting', async () => {
  const f = fixture()
  await new SecureStorageBackend(f.filePath).set(id, { value: 'dummy-saved-key' })
  const original = readFileSync(f.filePath)
  const backend = await checkServerStartupCredentials({ filePath: f.filePath })
  expect((await backend.get(id))?.value).toBe('dummy-saved-key')
  expect(readFileSync(f.filePath)).toEqual(original)
})

test('a temporarily unreadable vault recovers with a fresh backend and preserves its credentials', async () => {
  const f = fixture(), events: ServerCredentialDiagnostic[] = [], delays: number[] = []
  await new SecureStorageBackend(f.filePath).set(id, { value: 'dummy-original-key' })
  const original = readFileSync(f.filePath)
  const damaged = Buffer.from(original); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1
  writeFileSync(f.filePath, damaged)
  let instances = 0
  const backend = await checkServerStartupCredentials({
    backendFactory: () => { instances++; return new SecureStorageBackend(f.filePath) },
    wait: async delay => { delays.push(delay); writeFileSync(f.filePath, original) },
    report: event => events.push(event),
  })
  expect(instances).toBe(2)
  expect(delays).toEqual([250])
  expect(events).toEqual([{ event: 'retrying', attempt: 1, code: 'VAULT_READ_FAILED' }, { event: 'recovered', attempt: 2 }])
  expect((await backend.get(id))?.value).toBe('dummy-original-key')
  expect(readFileSync(f.filePath)).toEqual(original)
})

test('permanent corruption exhausts bounded retries and never resets or restores stale backups', async () => {
  const f = fixture(), delays: number[] = []
  const damaged = Buffer.from('dummy-corrupt-vault')
  writeFileSync(f.filePath, damaged)
  writeFileSync(`${f.filePath}.legacy-backup`, 'dummy-stale-backup')
  await expect(checkServerStartupCredentials({ filePath: f.filePath, wait: async delay => { delays.push(delay) } }))
    .rejects.toThrow('VAULT_CORRUPT')
  expect(delays).toEqual([250, 1000, 2500])
  expect(readFileSync(f.filePath)).toEqual(damaged)
  expect(readdirSync(f.directory).sort()).toEqual(['credentials.enc', 'credentials.enc.legacy-backup'])
})

test('desktop-only protection is identified immediately and the original vault is untouched', async () => {
  const f = fixture(), events: ServerCredentialDiagnostic[] = []
  const bytes = Buffer.alloc(100, 0x42); bytes.write('TBVAULT2'); bytes.writeUInt32LE(32, 8)
  writeFileSync(f.filePath, bytes)
  await expect(checkServerStartupCredentials({ filePath: f.filePath,
    wait: async () => { throw new Error('Native-only vault must not retry') }, report: event => events.push(event),
  })).rejects.toThrow('separate TOKENBIRD_CONFIG_DIR')
  expect(events).toEqual([{ event: 'blocked', attempt: 1, code: 'VAULT_NATIVE_ONLY' }])
  expect(readFileSync(f.filePath)).toEqual(bytes)
})

test('diagnostic failure cannot block healthy startup and raw backend errors never escape', async () => {
  const f = fixture()
  await expect(checkServerStartupCredentials({ filePath: f.filePath, report: () => { throw new Error('log unavailable') } })).resolves.toBeInstanceOf(SecureStorageBackend)
  let failure: unknown
  const events: ServerCredentialDiagnostic[] = []
  try {
    await checkServerStartupCredentials({ backendFactory: () => { throw new Error('DUMMY_SECRET_MUST_NOT_LEAK') },
      wait: async () => {}, report: event => events.push(event) })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ServerCredentialStartupError)
  expect(String(failure)).not.toContain('DUMMY_SECRET')
  expect(JSON.stringify(events)).not.toContain('DUMMY_SECRET')
  logServerCredentialDiagnostic(f.directory, events.at(-1)!)
  const logged = readFileSync(join(f.directory, 'logs/credential-startup.log'), 'utf8')
  expect(JSON.parse(logged)).toMatchObject({ event: 'blocked', attempt: 4, code: 'VAULT_READ_FAILED' })
  expect(logged).not.toContain('DUMMY_SECRET')
})

test('real standalone startup diagnoses a desktop vault before opening its listening port', async () => {
  const f = fixture()
  const bytes = Buffer.alloc(100, 0x42); bytes.write('TBVAULT2'); bytes.writeUInt32LE(32, 8)
  writeFileSync(f.filePath, bytes)
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts')], {
    env: { ...process.env, TOKENBIRD_CONFIG_DIR: f.directory, TOKENBIRD_DISABLE_MESSAGING: '1',
      TOKENBIRD_SERVER_TOKEN: 'dummy-server-startup-credential-check-token', TOKENBIRD_RPC_HOST: '127.0.0.1',
      TOKENBIRD_RPC_PORT: '0', TOKENBIRD_HEALTH_PORT: '0', TOKENBIRD_WEBUI_DIR: '',
      TOKENBIRD_RPC_TLS_CERT: '', TOKENBIRD_RPC_TLS_KEY: '', TOKENBIRD_RPC_TLS_CA: '',
    }, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 25000)
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(code).toBe(1)
    expect(stderr).toContain('VAULT_NATIVE_ONLY')
    expect(stderr).toContain('separate TOKENBIRD_CONFIG_DIR')
    expect(stdout).not.toContain('TOKENBIRD_SERVER_URL=')
    expect(stdout + stderr).not.toContain('dummy-server-startup-credential-check-token')
    expect(readFileSync(f.filePath)).toEqual(bytes)
    expect(JSON.parse(readFileSync(join(f.directory, 'logs/credential-startup.log'), 'utf8'))).toMatchObject({ event: 'blocked', code: 'VAULT_NATIVE_ONLY' })
  } finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill(); await proc.exited } }
}, 30000)
