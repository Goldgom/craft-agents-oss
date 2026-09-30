import { expect, test } from 'bun:test';
import { sanitizeMcpConnectionError } from '../connection-error.ts';

test('numeric SDK status classifies authentication failures without exposing response contents', () => {
  for (const code of [401, 403]) {
    const result = sanitizeMcpConnectionError(Object.assign(new Error('Rejected dummy-secret in response'), { code }));
    expect(result.needsAuth).toBe(true);
    expect(result.message).not.toContain('dummy-secret');
  }
  expect(sanitizeMcpConnectionError(Object.assign(new Error('dummy-secret'), { status: 404 })).message).toContain('endpoint not found');
  expect(sanitizeMcpConnectionError(new Error('dummy-secret')).message).not.toContain('dummy-secret');
});
