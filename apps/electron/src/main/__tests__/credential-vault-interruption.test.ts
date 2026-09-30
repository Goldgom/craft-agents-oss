import { afterEach, describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import type { CredentialKeyProtection } from '@craft-agent/shared/credentials/backends/vault-protection';

// Explicit public fixture key for dummy data, never an OS/user credential.
const fixtureKey = Buffer.alloc(32, 7);
function protection(): CredentialKeyProtection {
  return {
    assertAvailable() {},
    wrapKey(key) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', fixtureKey, iv);
      const bytes = Buffer.concat([cipher.update(key), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    unwrapKey(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', fixtureKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    },
  };
}
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const id = { type: 'llm_oauth' as const, connectionSlug: 'dummy-model' };

describe.skipIf(process.platform === 'win32')('owned-process native migration interruption', () => {
  for (const phase of ['after-encrypted-backup', 'after-native-temp-fsync', 'after-native-rename']) {
    test(`${phase} retains original encrypted rollback bytes and a readable old-or-new vault`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'native-vault-interruption-'));
      paths.push(directory);
      const path = join(directory, 'credentials.enc');
      const marker = join(directory, 'paused');
      await new SecureStorageBackend(path).set(id, { value: 'dummy-original-access', refreshToken: 'dummy-original-refresh' });
      const original = readFileSync(path);
      const backendUrl = new URL('../../../../../packages/shared/src/credentials/backends/secure-storage.ts', import.meta.url).href;
      const child = Bun.spawn([process.execPath, '--eval', `
        import fs from 'node:fs';
        import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
        import { mock } from 'bun:test';
        const actual = { ...fs }, phase = ${JSON.stringify(phase)}, target = ${JSON.stringify(path)};
        const descriptors = new Map();
        const pause = () => { actual.writeFileSync(${JSON.stringify(marker)}, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
        mock.module('fs', () => ({ ...actual,
          openSync(path, ...args) { const fd = actual.openSync(path, ...args); descriptors.set(fd, path); return fd; },
          fsyncSync(fd) { const result = actual.fsyncSync(fd); const name = descriptors.get(fd); if (phase === 'after-native-temp-fsync' && typeof name === 'string' && name.startsWith(target + '.') && name.endsWith('.tmp') && !name.includes('legacy-backup')) pause(); return result; },
          renameSync(from, to) { const result = actual.renameSync(from, to); if ((phase === 'after-encrypted-backup' && to === target + '.legacy-backup') || (phase === 'after-native-rename' && to === target)) pause(); return result; },
        }));
        const { SecureStorageBackend } = await import(${JSON.stringify(backendUrl)});
        const fixtureKey = Buffer.alloc(32, 7);
        const protection = (${protection.toString()})();
        await new SecureStorageBackend(target, protection).migrateToProtectedStorage();
      `], { stdout: 'pipe', stderr: 'pipe' });
      try {
        const deadline = performance.now() + 5000;
        while (!existsSync(marker) && child.exitCode === null && performance.now() < deadline) await Bun.sleep(5);
        if (!existsSync(marker)) {
          if (child.exitCode === null) child.kill('SIGKILL');
          await child.exited;
          throw new Error(`Dummy migration child did not pause: ${await new Response(child.stderr).text()}`);
        }
        child.kill('SIGKILL');
        expect(await child.exited).not.toBe(0);
        expect(new SecureStorageBackend(path, protection()).readLegacyRollbackSnapshot()).toEqual(original);
        expect(readFileSync(`${path}.legacy-backup`).subarray(0, 8).toString()).toBe('TBROLL01');
        const native = phase === 'after-native-rename';
        expect(readFileSync(path).subarray(0, 8).toString()).toBe(native ? 'TBVAULT2' : 'CRAFT01\0');
        const backend = new SecureStorageBackend(path, protection());
        expect((await backend.get(id))?.refreshToken).toBe('dummy-original-refresh');
        expect(existsSync(`${path}.lock`)).toBe(true);
        for (const name of readdirSync(directory).filter(name => name.endsWith('.tmp') || name.endsWith('.legacy-backup'))) {
          expect(readFileSync(join(directory, name)).includes(Buffer.from('dummy-original'))).toBe(false);
          expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
        }
        // Only this owned writer existed; its exit is confirmed. Production
        // never steals a lock or guesses whether another writer is still live.
        rmSync(`${path}.lock`);
        for (const name of readdirSync(directory).filter(name => name.endsWith('.tmp'))) rmSync(join(directory, name));
        await backend.set(id, { value: 'dummy-refreshed-after-recovery', refreshToken: 'dummy-recovered-refresh' });
        expect((await new SecureStorageBackend(path, protection()).get(id))?.value).toBe('dummy-refreshed-after-recovery');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    }, 10_000);
  }
});
