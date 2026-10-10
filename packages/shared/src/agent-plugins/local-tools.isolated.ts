import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tokenbird-local-tool-test-'));
const previousConfig = process.env.TOKENBIRD_CONFIG_DIR;
process.env.TOKENBIRD_CONFIG_DIR = join(root, 'config');
const { executeLocalAgentHostTool } = await import('./local-tools.ts');
afterAll(() => { if (previousConfig == null) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previousConfig; });

describe('Shared native tool execution', () => {
  test('edits preserve UTF-8 BOM and Windows line endings', async () => {
    const path = join(root, 'unicode.txt');
    writeFileSync(path, '\uFEFF甲\r\n乙\r\n');
    await executeLocalAgentHostTool('Edit', { file_path: path, old_string: '甲\n乙', new_string: '新\n乙' }, root, new AbortController().signal);
    expect(readFileSync(path, 'utf8')).toBe('\uFEFF新\r\n乙\r\n');
  });
  test('ambiguous edits fail without modifying the file', async () => {
    const path = join(root, 'ambiguous.txt'); writeFileSync(path, 'repeat repeat');
    await expect(executeLocalAgentHostTool('Edit', { file_path: path, old_string: 'repeat', new_string: 'changed' }, root, new AbortController().signal)).rejects.toThrow('ambiguous');
    expect(readFileSync(path, 'utf8')).toBe('repeat repeat');
  });
  test('stopped turns cannot start a write', async () => {
    const path = join(root, 'stopped.txt'); const controller = new AbortController(); controller.abort();
    await expect(executeLocalAgentHostTool('Write', { file_path: path, content: 'forbidden' }, root, controller.signal)).rejects.toThrow('stopped');
    expect(existsSync(path)).toBe(false);
  });
  test('shell failures retain output and report a nonzero exit', async () => {
    const result = await executeLocalAgentHostTool('Bash', { command: "printf 'hello'; printf 'problem' >&2; exit 3" }, root, new AbortController().signal);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain('hello'); expect(result?.content).toContain('problem'); expect(result?.content).toContain('Exit code: 3');
  });
  test('stopping shell execution kills its process tree and settles the call', async () => {
    const controller = new AbortController();
    const running = executeLocalAgentHostTool('Bash', { command: 'sleep 30' }, root, controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect(await running).toMatchObject({ isError: true });
  }, 15_000);
});
