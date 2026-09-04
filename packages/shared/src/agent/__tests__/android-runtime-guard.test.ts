/**
 * Tests for the Android runtime guard.
 *
 * Android (bionic libc) cannot execute the glibc-linked Claude binary, so the
 * backend must fail fast with an actionable message instead of attempting to
 * spawn the binary. See apps/android/build.ps1 (no longer bundles the binary).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  getDefaultOptions,
  isAndroidRuntime,
  ANDROID_CLAUDE_UNSUPPORTED_MESSAGE,
} from '../options.ts';
import {
  buildAndroidClaudeUnsupportedError,
} from '../errors.ts';
import {
  applyAnthropicRuntimeBootstrap,
  type ResolvedBackendRuntimePaths,
} from '../backend/internal/runtime-resolver.ts';
import type { BackendHostRuntimeContext } from '../backend/types.ts';

const SAVED_ANDROID = process.env.CRAFT_ANDROID;

afterEach(() => {
  if (SAVED_ANDROID === undefined) delete process.env.CRAFT_ANDROID;
  else process.env.CRAFT_ANDROID = SAVED_ANDROID;
});

describe('Android runtime guard', () => {
  it('reports the Android runtime when CRAFT_ANDROID=true', () => {
    process.env.CRAFT_ANDROID = 'true';
    expect(isAndroidRuntime()).toBe(true);
  });

  it('reports a non-Android runtime when CRAFT_ANDROID is unset', () => {
    delete process.env.CRAFT_ANDROID;
    expect(isAndroidRuntime()).toBe(false);
  });

  it('fails fast in getDefaultOptions instead of spawning the glibc binary', () => {
    process.env.CRAFT_ANDROID = 'true';
    expect(() => getDefaultOptions()).toThrow(ANDROID_CLAUDE_UNSUPPORTED_MESSAGE);
  });

  it('fails fast in strict runtime bootstrap', () => {
    process.env.CRAFT_ANDROID = 'true';
    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: '/android/app',
      resourcesPath: '/android/app/resources',
      isPackaged: true,
    };
    const paths: ResolvedBackendRuntimePaths = {};
    expect(() => applyAnthropicRuntimeBootstrap(hostRuntime, paths)).toThrow(
      ANDROID_CLAUDE_UNSUPPORTED_MESSAGE,
    );
  });

  it('skips silently in non-strict runtime bootstrap on Android', () => {
    process.env.CRAFT_ANDROID = 'true';
    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: '/android/app',
      resourcesPath: '/android/app/resources',
      isPackaged: true,
    };
    const paths: ResolvedBackendRuntimePaths = {};
    expect(() =>
      applyAnthropicRuntimeBootstrap(hostRuntime, paths, { strict: false }),
    ).not.toThrow();
  });

  it('builds a typed error carrying the Android reason', () => {
    const error = buildAndroidClaudeUnsupportedError('raw spawn error');
    expect(error.code).toBe('android_claude_unsupported');
    expect(error.canRetry).toBe(false);
    expect(error.message).toContain('bionic libc');
    expect(error.details?.join(' ')).toContain('glibc');
    expect(error.originalError).toBe('raw spawn error');
  });
});
