import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCredentialManager } from '../../credentials/index.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';
import { PiAgent } from '../pi-agent.ts';
import { NativeCodexAgent } from '../native-codex-agent.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import * as config from '../../config/storage.ts';
const cleanups: Array<() => void> = [];
afterEach(() => { jest.useRealTimers(); for (const fn of cleanups.splice(0).reverse()) fn(); });
function fixture(authType = 'api_key') {
  const root = mkdtempSync(join(tmpdir(), 'credential-runtime-boundary-'));
  const manager = getCredentialManager(), previous = { backends: (manager as any).backends, writeBackend: (manager as any).writeBackend, initialized: (manager as any).initialized, initPromise: (manager as any).initPromise };
  const backend = new SecureStorageBackend(join(root, 'credentials.enc')); manager.configureBackend(backend);
  cleanups.push(() => { Object.assign(manager, previous); rmSync(root, { recursive: true, force: true }); });
  const id = { type: authType === 'oauth' ? 'llm_oauth' as const : authType === 'iam_credentials' ? 'llm_iam' as const : 'llm_api_key' as const, connectionSlug: 'dummy-provider' };
  const options = { provider: 'pi', authType, connectionSlug: id.connectionSlug, workspace: { id: 'dummy', name: 'Dummy', rootPath: root }, session: { id: 'dummy-session', workspaceRootPath: root, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true, runtime: { piAuthProvider: authType === 'iam_credentials' ? 'amazon-bedrock' : 'openai-codex' } } as any;
  return { root, manager, backend, id, options };
}
async function fakePi(authType = 'api_key') {
  const f = fixture(authType); const agent: any = new PiAgent(f.options);
  await f.backend.set(f.id, { value: 'dummy-old', refreshToken: 'dummy-refresh', awsAccessKeyId: 'dummy-access-id', expiresAt: Date.now() + 3600000 });
  const sent: any[] = [], killed: string[] = [];
  agent.subprocess = { pid: undefined, kill: (signal: string) => { killed.push(signal); return true; } };
  agent.subprocessReady = Promise.resolve(); agent.send = (command: any) => sent.push(command);
  agent.lastInjectedAuthFingerprint = agent.authFingerprint(await agent.getPiAuth()); agent.lastInjectedAuthHadCredential = true;
  cleanups.push(() => { agent.destroy(); }); return { ...f, agent, sent, killed };
}
async function until(check: () => boolean) { for (let n = 0; n < 30 && !check(); n++) await Promise.resolve(); expect(check()).toBe(true); }
for (const authType of ['api_key', 'oauth']) test(`Pi ${authType} changed auth requires exact ACK before next prompt`, async () => {
  const f = await fakePi(authType); await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-new' } }]);
  let promptSent = false;
  const nextTurn = f.agent.synchronizeStoredAuthBeforeTurn().then(() => { promptSent = true; });
  await until(() => f.sent.length === 1); expect(f.sent[0].type).toBe('token_update'); expect(promptSent).toBe(false);
  f.agent.handleLine(JSON.stringify({ type: 'token_update_result', id: 'wrong-id', success: true })); await Promise.resolve(); expect(promptSent).toBe(false); expect(f.agent.pendingAuthUpdates.size).toBe(1);
  f.agent.handleLine(JSON.stringify({ type: 'token_update_result', id: f.sent[0].id, success: true })); await nextTurn;
  expect(promptSent).toBe(true); expect(f.agent.pendingAuthUpdates.size).toBe(0); expect(f.killed).toHaveLength(0);
  await f.agent.synchronizeStoredAuthBeforeTurn(); expect(f.sent).toHaveLength(1);
});
test('Pi deletion blocks a new prompt without reusing the old API key or interrupting current work at save time', async () => {
  const f = await fakePi(); f.agent._isProcessing = true;
  await f.backend.applyChanges([{ op: 'delete', id: f.id }]); expect(f.sent).toHaveLength(0); expect(f.killed).toHaveLength(0);
  f.agent._isProcessing = false;
  await expect(f.agent.synchronizeStoredAuthBeforeTurn()).rejects.toThrow('Update Credentials in Settings');
  expect(f.sent).toHaveLength(0); expect(f.killed).toHaveLength(0);
});
test('Pi IAM replacement blocks a new prompt without killing child/background work or changing session/model state', async () => {
  const f = await fakePi('iam_credentials'); f.agent.piSessionId = 'durable-session'; f.agent._model = 'kept-model';
  await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-new-secret' } }]);
  let rejected = false;
  f.agent.pendingMiniCompletions.set('dummy-background', { resolve() {}, reject() { rejected = true; }, timeout: setTimeout(() => {}, 60000) });
  expect(f.killed).toHaveLength(0); await expect(f.agent.synchronizeStoredAuthBeforeTurn()).rejects.toThrow('background work');
  expect(f.killed).toHaveLength(0); expect(rejected).toBe(false); expect(f.agent.piSessionId).toBe('durable-session'); expect(f.agent._model).toBe('kept-model'); expect(f.agent.subprocess).not.toBeNull();
});
test('Pi auth ACK failure is sanitized and timeout/destroy release pending state', async () => {
  const f = await fakePi(); const auth = await f.agent.getPiAuth();
  const pending = f.agent.pushAuthUpdate(auth).catch((error: Error) => error);
  f.agent.handleLine(JSON.stringify({ type: 'token_update_result', id: f.sent[0].id, success: false, message: 'dummy-secret-echo' }));
  expect(String(await pending)).not.toContain('dummy-secret-echo'); expect(f.agent.pendingAuthUpdates.size).toBe(0);
  jest.useFakeTimers(); const timeout = f.agent.pushAuthUpdate(auth).catch((error: Error) => error); jest.advanceTimersByTime(15001);
  expect(String(await timeout)).toContain('not acknowledged'); expect(f.agent.pendingAuthUpdates.size).toBe(0);
  const destroyed = f.agent.pushAuthUpdate(auth).catch((error: Error) => error); f.agent.destroy();
  expect(String(await destroyed)).toContain('stopped'); expect(f.agent.pendingAuthUpdates.size).toBe(0);
});
test('native Codex rotates stored API key only at a new-turn boundary and blocks deletion', async () => {
  const f = fixture(); await f.backend.set(f.id, { value: 'dummy-old' });
  const agent: any = new NativeCodexAgent(f.options, { path: 'codex', source: 'PATH', version: '0.154.0', testedProtocol: true }); cleanups.push(() => agent.destroy());
  const calls: any[] = []; const client = { request: async (...args: any[]) => { calls.push(args); return {}; } };
  expect(await agent.authenticateClient(client)).toBe(true); agent.authenticated = true; calls.length = 0;
  await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-new' } }]); expect(calls).toHaveLength(0);
  await agent.synchronizeStoredAuthBeforeTurn(client); expect(calls).toEqual([['account/login/start', { type: 'apiKey', apiKey: 'dummy-new' }]]);
  await agent.synchronizeStoredAuthBeforeTurn(client); expect(calls).toHaveLength(1);
  await f.backend.applyChanges([{ op: 'delete', id: f.id }]); await expect(agent.synchronizeStoredAuthBeforeTurn(client)).rejects.toThrow('Update Credentials in Settings'); expect(calls).toHaveLength(1);
});
async function fakeClaude() {
  const f = fixture(); await f.backend.set(f.id, { value: 'dummy-old', expiresAt: 1 });
  const connection = spyOn(config, 'getLlmConnection').mockReturnValue({ slug: f.id.connectionSlug, authType: 'api_key', providerType: 'anthropic' } as any); cleanups.push(() => connection.mockRestore());
  const defaults = spyOn(config, 'loadConfigDefaults').mockReturnValue({ workspaceDefaults: { permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'] } } as any); cleanups.push(() => defaults.mockRestore());
  const agent: any = new ClaudeAgent({ ...f.options, provider: 'anthropic' });
  await agent.captureInjectedCredentialState();
  let ended = 0; const stream = { end: () => { ended++; } };
  agent.persistentInput = stream;
  cleanups.push(() => { agent.persistentInput = null; agent.destroy(); });
  return { ...f, agent, stream, ended: () => ended };
}
test('Claude explicit changed/deleted auth blocks only a new prompt, preserving persistent/background work', async () => {
  const f = await fakeClaude(); await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-new' } }]);
  expect(await f.agent.notifyStoredCredentialChanges([{ op: 'upsert', id: f.id, fields: ['value'] }])).toBe(true);
  const events: any[] = []; for await (const event of f.agent.chatImpl('must not reach SDK')) events.push(event);
  expect(events[0].type).toBe('error'); expect(events[0].message).toContain('background work'); expect(events[1].type).toBe('complete');
  expect(f.ended()).toBe(0); expect(f.agent.persistentInput).toBe(f.stream);
  await f.backend.applyChanges([{ op: 'delete', id: f.id }]); expect(await f.agent.notifyStoredCredentialChanges([{ op: 'delete', id: f.id }])).toBe(true);
  await expect(f.agent.assertExplicitCredentialsAtTurnBoundary()).rejects.toThrow('Start a new session'); expect(f.ended()).toBe(0);
});
test('Claude metadata edits and automatic refresh do not introduce a restart guard', async () => {
  const f = await fakeClaude(); await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { expiresAt: Date.now() + 10000 } }]);
  expect(await f.agent.notifyStoredCredentialChanges([{ op: 'upsert', id: f.id, fields: ['expiresAt'] }])).toBe(false);
  await f.agent.assertExplicitCredentialsAtTurnBoundary();
  await f.backend.set(f.id, { value: 'dummy-automatic-refresh' }); // Runtime writes do not send Settings notification.
  await f.agent.assertExplicitCredentialsAtTurnBoundary(); expect(f.ended()).toBe(0);
});

for (const authType of ['api_key', 'oauth']) test(`Pi ${authType} deletion while auth ACK is pending cannot authorize the next prompt`, async () => {
  const f = await fakePi(authType); await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-new' } }]);
  const pending = f.agent.synchronizeStoredAuthBeforeTurn().then(() => null, (error: Error) => error);
  await until(() => f.sent.length === 1); await f.backend.applyChanges([{ op: 'delete', id: f.id }]);
  f.agent.handleLine(JSON.stringify({ type: 'token_update_result', id: f.sent[0].id, success: true }));
  expect(String(await pending)).toContain('Credentials changed'); expect(await f.backend.get(f.id)).toBeNull(); expect(f.agent.pendingAuthUpdates.size).toBe(0); expect(f.killed).toHaveLength(0);
});

test('Claude edit during delayed postInit auth resolution cannot be cleared by later baseline capture', async () => {
  const f = await fakeClaude(); f.agent.persistentInput = null;
  const oldEnv = { api: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL };
  cleanups.push(() => { for (const [key, value] of [['ANTHROPIC_API_KEY', oldEnv.api], ['CLAUDE_CODE_OAUTH_TOKEN', oldEnv.oauth], ['ANTHROPIC_BASE_URL', oldEnv.base]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => started = resolve), held = new Promise<void>(resolve => release = resolve);
  const original = f.manager.getLlmApiKey.bind(f.manager);
  const read = spyOn(f.manager, 'getLlmApiKey').mockImplementation(async slug => { const value = await original(slug); started(); await held; return value; }); cleanups.push(() => read.mockRestore());
  const pending = f.agent.postInit(); await entered;
  await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-manual-during-init' } }]);
  await f.agent.notifyStoredCredentialChanges([{ op: 'upsert', id: f.id, fields: ['value'] }]); release(); await pending;
  expect(f.agent.pendingExplicitCredentialIds.size).toBe(1);
  f.agent.persistentInput = f.stream;
  await expect(f.agent.assertExplicitCredentialsAtTurnBoundary()).rejects.toThrow('Start a new session'); expect(f.ended()).toBe(0);
});

test('Pi retains fixed vault failures instead of misclassifying missing OAuth/API authentication', async () => {
  const f = await fakePi();
  const { CredentialVaultError } = await import('../../credentials/backends/vault-protection.ts');
  const failing = spyOn(f.manager, 'getLlmApiKey').mockRejectedValue(new CredentialVaultError('OS_STORAGE_UNAVAILABLE')); cleanups.push(() => failing.mockRestore());
  await expect(f.agent.getPiAuth()).rejects.toBeInstanceOf(CredentialVaultError);
  expect(f.sent).toHaveLength(0); expect(f.killed).toHaveLength(0);
});
