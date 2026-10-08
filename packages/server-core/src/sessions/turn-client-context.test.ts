import { describe, expect, test } from 'bun:test';
import { TurnClientContexts } from './turn-client-context';
import { CLIENT_REMOTE_ACCESS, CLIENT_REQUEST_FILES, type RpcServer } from '../transport';

describe('remote turn client context', () => {
  const clients = new Map([['a', 'workspace'], ['b', 'workspace'], ['other', 'other-workspace']]);
  const server = {
    hasClientCapability: (id: string, cap: string) => clients.has(id) && [CLIENT_REMOTE_ACCESS, CLIENT_REQUEST_FILES].includes(cap),
    findClientsWithCapability: (_cap: string, scope: { workspaceId: string }) => [...clients].filter(([, ws]) => ws === scope.workspaceId).map(([id]) => id),
  } as RpcServer;
  test('the initiating device is used even when another device connects first; a queued caller cannot change it', () => {
    const contexts = new TurnClientContexts();
    contexts.bind('session', contexts.capture(server, { callerClientId: 'b' }));
    const queued = contexts.capture(server, { callerClientId: 'a' });
    expect(contexts.requireClient(server, 'session', 'workspace', CLIENT_REQUEST_FILES)).toBe('b');
    expect(contexts.reminder(server, 'session')).toContain('REMOTE ACCESS');
    expect(contexts.reminder(server, 'session')).toContain('request_client_files');
    contexts.bind('session', queued);
    expect(contexts.requireClient(server, 'session', 'workspace', CLIENT_REQUEST_FILES)).toBe('a');
  });
  test('retains remote mode after disconnect without falling back to another device or workspace', () => {
    const contexts = new TurnClientContexts();
    const queued = contexts.capture(server, { callerClientId: 'b' });
    clients.delete('b');
    try {
      contexts.bind('session', queued);
      expect(contexts.reminder(server, 'session')).toContain('REMOTE ACCESS');
      expect(() => contexts.requireClient(server, 'session', 'workspace', CLIENT_REQUEST_FILES)).toThrow('disconnected');
      contexts.bind('session', contexts.capture(server, { callerClientId: 'other' }));
      expect(() => contexts.requireClient(server, 'session', 'workspace', CLIENT_REQUEST_FILES)).toThrow();
    } finally { clients.set('b', 'workspace'); }
  });
  test('local mode and disconnected cleanup replace remote context', () => {
    const contexts = new TurnClientContexts();
    expect(contexts.reminder(server, 's')).toBe('');
    contexts.bind('s', { callerClientId: 'a', remoteAccess: false });
    expect(contexts.reminder(server, 's')).toContain('mode: local');
    expect(contexts.reminder(server, 's')).not.toContain('REMOTE ACCESS');
    contexts.delete('s');
    expect(contexts.reminder(server, 's')).toBe('');
  });
});
