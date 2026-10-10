/** Real Chromium ↔ headless-host interoperability, without external services.
 * Run: bun run scripts/tokenbird-cloud-direct.smoke.ts
 * Override browser path with TOKENBIRD_SMOKE_BROWSER. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startCloudServer } from '../packages/cloud-server/src/server'
import { CloudClient } from '../packages/server-core/src/cloud/client'
import { saveCloudConfig } from '../packages/server-core/src/cloud/storage'
import { WsRpcServer } from '../packages/server-core/src/transport/server'

const directory = mkdtempSync(join(tmpdir(), 'tokenbird-browser-direct-'))
const previous = process.env.TOKENBIRD_CONFIG_DIR
process.env.TOKENBIRD_CONFIG_DIR = join(directory, 'config')
const cleanup: Array<() => unknown> = []
async function until<T>(get: () => T | undefined, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout
  while (true) { const value = get(); if (value) return value; if (Date.now() > end) throw new Error('Smoke check timed out'); await Bun.sleep(25) }
}
try {
  const browser = process.env.TOKENBIRD_SMOKE_BROWSER ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(existsSync)
  if (!browser || !existsSync(browser)) throw new Error('Set TOKENBIRD_SMOKE_BROWSER to a Chromium executable')
  const entry = join(directory, 'entry.ts')
  writeFileSync(entry, `import { WsRpcClient } from ${JSON.stringify(resolve('packages/server-core/src/transport/client.ts'))}; window.WsRpcClient = WsRpcClient;`)
  const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', outdir: directory, naming: 'client.js' })
  if (!bundle.success) throw new Error(bundle.logs.join('\n'))
  writeFileSync(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/client.js"></script>')
  const cloud = startCloudServer({ publicUrl: 'http://127.0.0.1:0', port: 0, databasePath: ':memory:', webuiDir: directory, iceServers: [],
    authenticate: async token => { if (token !== 'smoke-owner') throw new Error('Authentication required'); return { subject: token, expiresAt: Date.now() + 3600_000 } }, recordDevice: async () => {} })
  cleanup.push(() => cloud.stop())
  const origin = `http://127.0.0.1:${cloud.server.port}`
  let calls = 0
  const rpc = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async token => token === 'smoke-local-secret' })
  rpc.handle('echo', async (_ctx, input) => { calls++; return input })
  rpc.handle('capability', ctx => rpc.invokeClientWithTimeout(ctx.clientId, 'client:echo', 5000, 'browser capability'))
  await rpc.listen(); cleanup.push(() => rpc.close())
  const host = new CloudClient({ url: `ws://127.0.0.1:${rpc.port}`, token: 'smoke-local-secret' })
  cleanup.push(() => host.stop())
  host.request = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer smoke-owner', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as T
  }
  saveCloudConfig({ serverUrl: origin, connectionSlug: 'test', deviceName: 'Browser smoke host', remoteEnabled: true })
  host.start(); await until(() => host.status.connected)
  const grant = await host.request<{ url: string; token: string }>(`/v1/devices/${host.status.deviceId}/connect`, 'POST')
  const profile = join(directory, 'browser-profile')
  const processHandle = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  cleanup.push(() => { processHandle.kill() })
  const debugPortFile = join(profile, 'DevToolsActivePort')
  const debugPort = await until(() => existsSync(debugPortFile) ? Number(readFileSync(debugPortFile, 'utf8').split('\n')[0]) : undefined)
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>
  const cdp = new WebSocket(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl)
  cleanup.push(() => cdp.terminate())
  await new Promise<void>((done, fail) => { cdp.once('open', done); cdp.once('error', fail) })
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  cdp.on('message', raw => {
    const message = JSON.parse(raw.toString())
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result)
  })
  function command(method: string, params: unknown): Promise<any> {
    return new Promise((resolveResult, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30_000)
      pending.set(id, { resolve: resolveResult, reject, timer })
      cdp.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression: string): Promise<any> {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Browser evaluation failed')
    return result.result?.value
  }
  await command('Page.navigate', { url: `${origin}/connect/${host.status.deviceId}` })
  const end = Date.now() + 15_000
  while (!await evaluate('typeof window.WsRpcClient === "function"')) { if (Date.now() > end) throw new Error('Browser bundle did not load'); await Bun.sleep(50) }
  const result = await evaluate(`(async () => {
    const grant = ${JSON.stringify(grant)};
    window.client = new window.WsRpcClient(grant.url, { token: grant.token, autoReconnect: false, clientCapabilities: ['client:echo'], requestTimeout: 15000 });
    client.handleCapability('client:echo', input => ({ input }));
    client.connect();
    const large = '中文🙂"\\\\'.repeat(40000);
    const echo = await client.invoke('echo', large);
    const capability = await client.invoke('capability');
    return { path: client.getConnectionState().dataPath, echoMatches: echo === large, capability };
  })()`)
  assert.equal(result.path, 'direct'); assert.equal(result.echoMatches, true)
  assert.deepEqual(result.capability, { input: 'browser capability' }); assert.equal(calls, 1)
  await host.request(`/v1/devices/${host.status.deviceId}`, 'DELETE')
  const revoked = await evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Revocation did not close browser connection')), 5000);
    const check = () => { if (client.getConnectionState().status === 'disconnected') { clearTimeout(timer); resolve(true); } else setTimeout(check, 20); }; check();
  })`)
  assert.equal(revoked, true)
  console.log(JSON.stringify({ browser: 'Chromium', direct: true, largeUnicodeEcho: true, bidirectionalCapability: true, revocation: true }))
} finally {
  for (const action of cleanup.reverse()) { try { await action() } catch {} }
  if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous
  // Chromium releases profile handles asynchronously on Windows.
  await Bun.sleep(500)
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
