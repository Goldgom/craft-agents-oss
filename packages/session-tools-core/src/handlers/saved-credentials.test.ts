import { expect, mock, test } from 'bun:test';
import { handleSavedCredentials } from './saved-credentials';
import { SavedCredentialsSchema, getSessionSafeBlockedToolNames } from '../tool-defs';

test('requests use secure auth handoff with a named destination and explicit replacement hint', async () => {
  const onAuthRequest = mock((_request: unknown) => {});
  const ctx = { sessionId: 'session', savedCredentialsFn: mock(async () => [{ name: '工作邮箱' }]), callbacks: { onAuthRequest } } as any;
  const result = await handleSavedCredentials(ctx, { action: 'request', name: '工作邮箱', kind: 'password', url: 'https://example.com' });
  expect(result.isError).not.toBe(true);
  expect(onAuthRequest.mock.calls[0]?.[0]).toMatchObject({ type: 'credential', mode: 'basic', savedCredentialName: '工作邮箱', savedCredentialKind: 'password', hint: 'credentialReplace' });
  expect(JSON.stringify(result)).not.toContain('password:');
});

test('unavailable host never prompts; sensitive exceptions never reach the model', async () => {
  const onAuthRequest = mock(() => {});
  const ctx = { sessionId: 'session', callbacks: { onAuthRequest } } as any;
  expect((await handleSavedCredentials(ctx, { action: 'request', name: 'key' })).isError).toBe(true);
  expect(onAuthRequest).not.toHaveBeenCalled();
  ctx.savedCredentialsFn = mock(async () => { throw new Error('leaked-secret-value'); });
  const result = await handleSavedCredentials(ctx, { action: 'fill', name: 'key' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('leaked-secret-value');
});

test('schema rejects scope aliases, secret URLs and environment overrides; Explore blocks use', () => {
  for (const name of ['bad::alias', 'bad\nname']) expect(SavedCredentialsSchema.safeParse({ action: 'request', name }).success).toBe(false);
  for (const url of ['file:///secret', 'https://user:password@example.com', 'https://example.com?key=secret']) expect(SavedCredentialsSchema.safeParse({ action: 'request', name: 'key', url }).success).toBe(false);
  expect(SavedCredentialsSchema.safeParse({ action: 'run', env: { PATH: 'secret' } }).success).toBe(false);
  expect(getSessionSafeBlockedToolNames().has('saved_credentials')).toBe(true);
});
