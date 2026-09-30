import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackend } from '../backends/secure-storage.ts';
import type { CredentialId } from '../types.ts';

let directory: string;
let path: string;
const id = (sourceId: string): CredentialId => ({ type: 'source_bearer', workspaceId: 'dummy-interruption', sourceId });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tokenbird-vault-interruption-')); path = join(directory, 'credentials.enc'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

// Mocks live only inside our own disposable child, never in the suite process.
// Interrupt real encrypted writes at explicit durability/commit boundaries.
function interruptedWriter(phase: string) {
  const marker = join(directory, 'child-paused');
  const moduleUrl = new URL('../backends/secure-storage.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--eval', `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    const actual = { ...fs };
    const phase = ${JSON.stringify(phase)};
    function pause() {
      actual.writeFileSync(${JSON.stringify(marker)}, 'ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    mock.module('fs', () => ({ ...actual,
      writeFileSync(file, data, ...args) {
        if (phase === 'partial-temporary-write' && typeof file === 'number') {
          actual.writeSync(file, data.subarray(0, 19));
          pause();
        }
        return actual.writeFileSync(file, data, ...args);
      },
      fsyncSync(fd) {
        const result = actual.fsyncSync(fd);
        if (phase === 'after-temporary-fsync') pause();
        return result;
      },
      renameSync(from, to) {
        const result = actual.renameSync(from, to);
        if (phase === 'after-atomic-rename') pause();
        return result;
      },
    }));
    const { SecureStorageBackend } = await import(${JSON.stringify(moduleUrl)});
    await new SecureStorageBackend(${JSON.stringify(path)}).set(${JSON.stringify(id('new'))}, { value: 'dummy-new-secret' });
  `], { stdout: 'pipe', stderr: 'pipe' });
  return { child, marker };
}

describe.skipIf(process.platform === 'win32')('process interruption and safe stale-lock recovery', () => {
  for (const phase of ['partial-temporary-write', 'after-temporary-fsync', 'after-atomic-rename']) {
    test(`${phase} preserves a readable atomic snapshot and requires explicit recovery`, async () => {
      const backend = new SecureStorageBackend(path);
      await backend.set(id('old'), { value: 'dummy-old-secret' });
      const original = readFileSync(path);
      const { child, marker } = interruptedWriter(phase);
      try {
        const deadline = Date.now() + 5000;
        while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
        if (!existsSync(marker)) {
          if (child.exitCode === null) child.kill('SIGKILL');
          await child.exited;
          throw new Error(`Fault-injection child never paused: ${await new Response(child.stderr).text()}`);
        }
        expect(existsSync(`${path}.lock`)).toBe(true);
        child.kill('SIGKILL');
        expect(await child.exited).not.toBe(0);

        const committed = phase === 'after-atomic-rename';
        if (committed) expect(readFileSync(path)).not.toEqual(original);
        else expect(readFileSync(path)).toEqual(original);
        expect((await backend.get(id('old')))?.value).toBe('dummy-old-secret');
        expect((await backend.get(id('new')))?.value ?? null).toBe(committed ? 'dummy-new-secret' : null);
        const temporaryFiles = readdirSync(directory).filter(name => name.endsWith('.tmp'));
        expect(temporaryFiles).toHaveLength(committed ? 0 : 1);
        for (const name of temporaryFiles) {
          const temporaryPath = join(directory, name);
          expect(readFileSync(temporaryPath).includes(Buffer.from('dummy-new-secret'))).toBe(false);
          expect(statSync(temporaryPath).mode & 0o777).toBe(0o600);
        }

        const interruptedSnapshot = readFileSync(path);
        await expect(backend.set(id('recovered'), { value: 'dummy-recovered' })).rejects.toThrow('stop all instances');
        expect(readFileSync(path)).toEqual(interruptedSnapshot);
        expect(existsSync(`${path}.lock`)).toBe(true);

        // Only this fixture's writer existed, and its termination is confirmed.
        // Production intentionally never guesses whether a lock is stale.
        rmSync(`${path}.lock`);
        for (const name of temporaryFiles) rmSync(join(directory, name));
        await backend.set(id('recovered'), { value: 'dummy-recovered' });
        const fresh = new SecureStorageBackend(path);
        expect((await fresh.get(id('old')))?.value).toBe('dummy-old-secret');
        expect((await fresh.get(id('recovered')))?.value).toBe('dummy-recovered');
        expect(await fresh.list()).toHaveLength(committed ? 3 : 2);
        expect(existsSync(`${path}.lock`)).toBe(false);
        expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    }, 15000);
  }
});
