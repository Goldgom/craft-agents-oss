import { describe, expect, it } from 'bun:test';
import { handleAndroidAdb, handleAndroidPermission } from './android-device.ts';

function text(result: Awaited<ReturnType<typeof handleAndroidPermission>>): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

describe('Android device tools', () => {
  it('reports a missing Android client without falling back', async () => {
    const result = await handleAndroidPermission({} as any, { action: 'status' });
    expect(text(result)).toContain('No connected Android client');
  });

  it('requires a user-facing reason before requesting permission', async () => {
    const result = await handleAndroidPermission({
      androidPermissionFn: async () => ({ permissions: [] }),
    } as any, { action: 'request', permission: 'camera' });
    expect(text(result)).toContain('reason is required');
  });

  it('forwards allowlisted permission requests to the Android bridge', async () => {
    let received: unknown;
    const result = await handleAndroidPermission({
      androidPermissionFn: async args => {
        received = args;
        return { permissions: [{ key: 'camera', status: 'granted' }] };
      },
    } as any, { action: 'request', permission: 'camera', reason: 'Scan the document' });
    expect(received).toEqual({ action: 'request', permission: 'camera', reason: 'Scan the document' });
    expect(text(result)).toContain('granted');
  });

  it('requires a reason for every ADB shell command', async () => {
    const result = await handleAndroidAdb({
      androidAdbFn: async () => ({ stdout: '' }),
    } as any, { action: 'shell', command: 'getprop ro.product.model' });
    expect(text(result)).toContain('reason is required');
  });

  it('forwards one ADB command without server-side fallback', async () => {
    let received: unknown;
    const result = await handleAndroidAdb({
      androidAdbFn: async args => {
        received = args;
        return { stdout: 'V1981A\n', exitCode: 0, truncated: false };
      },
    } as any, {
      action: 'shell',
      command: 'getprop ro.product.model',
      reason: 'Identify the connected phone',
    });
    expect(received).toEqual({
      action: 'shell',
      command: 'getprop ro.product.model',
      reason: 'Identify the connected phone',
    });
    expect(text(result)).toContain('V1981A');
  });
});
