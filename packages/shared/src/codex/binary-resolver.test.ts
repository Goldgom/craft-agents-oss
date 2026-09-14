import { afterEach, describe, expect, it } from 'bun:test';
import { clearNativeCodexBinaryCache, resolveNativeCodexBinary } from './binary-resolver.ts';

afterEach(() => clearNativeCodexBinaryCache());

describe('resolveNativeCodexBinary', () => {
  it('returns null when no candidate exists', () => {
    expect(resolveNativeCodexBinary({ env: { PATH: '', CRAFT_CODEX_PATH: 'Z:\\missing\\codex.exe' }, useCache: false })).toBeNull();
  });

  it('rejects untested protocol versions by default', () => {
    expect(resolveNativeCodexBinary({ env: { PATH: '', CRAFT_CODEX_PATH: process.execPath }, useCache: false })).toBeNull();
  });

  it('allows an explicit untested-version escape hatch', () => {
    const result = resolveNativeCodexBinary({
      env: { PATH: '', CRAFT_CODEX_PATH: process.execPath, CRAFT_CODEX_ALLOW_UNTESTED: '1' },
      useCache: false,
    });
    expect(result?.path).toBe(process.execPath);
    expect(result?.testedProtocol).toBe(false);
  });
});
