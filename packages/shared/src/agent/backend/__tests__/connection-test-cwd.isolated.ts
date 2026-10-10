import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCredentialManager } from '../../../credentials/index.ts';
import { testBackendConnection } from '../factory.ts';

// Exercise the factory and real Bun spawn, with only the Pi JSONL peer stubbed.
// An ENOENT from spawn also means the cwd is missing, even if Bun exists.
test.each(['pi/deepseek-v4-pro', 'pi/deepseek-v4-flash', 'pi/deepseek-v4-flash-vision-exp'])(
  'connection setup can spawn Bun for %s without a persisted session directory',
  async (model) => {
    const root = mkdtempSync(join(tmpdir(), 'connection-test-cwd-'));
    const serverDir = join(root, 'resources', 'pi-agent-server');
    const capturePath = join(root, 'init.json');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'index.js'), `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      createInterface({ input: process.stdin }).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.type === 'init') {
          writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
            cwd: process.cwd(), sessionId: msg.sessionId, model: msg.model,
            provider: msg.piAuth?.provider, workingDirectory: msg.workingDirectory,
          }));
          send({ type: 'ready' });
        } else if (msg.type === 'set_auto_compaction') {
          send({ type: 'set_auto_compaction_result', id: msg.id, success: true, enabled: msg.enabled });
        } else if (msg.type === 'register_tools') {
          send({ type: 'tools_registered', id: msg.id, count: msg.tools.length, total: msg.tools.length });
        } else if (msg.type === 'mini_completion') {
          send({ type: 'mini_completion_result', id: msg.id, text: 'ok' });
        }
      });
    `);

    // Keep dummy credentials in memory; never touch the user's credential vault.
    const manager = getCredentialManager();
    const keys = new Map<string, string>();
    const setKey = spyOn(manager, 'setLlmApiKey').mockImplementation(async (slug, key) => { keys.set(slug, key); });
    const getKey = spyOn(manager, 'getLlmApiKey').mockImplementation(async slug => keys.get(slug) ?? null);
    const deleteKey = spyOn(manager, 'deleteLlmApiKey').mockImplementation(async slug => keys.delete(slug));
    try {
      const result = await testBackendConnection({
        provider: 'pi', apiKey: 'dummy-deepseek-key', model,
        connection: { providerType: 'pi', piAuthProvider: 'deepseek' },
        hostRuntime: { appRootPath: root, isPackaged: true, nodeRuntimePath: process.execPath },
        timeoutMs: 5000,
      });
      expect(result).toEqual({ success: true });
      const init = JSON.parse(readFileSync(capturePath, 'utf8'));
      expect(init.cwd).toBe(homedir());
      expect(init.workingDirectory).toBe(homedir());
      expect(init.model).toBe(model);
      expect(init.provider).toBe('deepseek');
      expect(existsSync(join(homedir(), 'sessions', init.sessionId))).toBe(false);
      expect(keys.size).toBe(0);
    } finally {
      setKey.mockRestore(); getKey.mockRestore(); deleteKey.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
