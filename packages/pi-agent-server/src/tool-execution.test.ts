import { describe, expect, it } from 'bun:test';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { appendToolDiagnostic, runToolPhase, withBashTimeout } from './tool-execution.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('shell execution budgets', () => {
  it('supplies a default and preserves explicit budgets including invalid values for SDK validation', async () => {
    const budgets: unknown[] = [];
    const tool = withBashTimeout({ ...createBashToolDefinition(process.cwd()), execute: async (_id, params) => { budgets.push(params.timeout); return { content: [] }; } });
    expect(tool.parameters.properties.timeout.description).toContain('default 120');
    expect(validateToolArguments(tool, { type: 'toolCall', id: 'check', name: 'bash', arguments: { command: 'echo ok' } })).toEqual({ command: 'echo ok' });
    for (const params of [{ command: 'echo ok' }, { command: 'go test', timeout: 400 }, { command: 'echo ok', timeout: 0 }]) await tool.execute('x', params);
    expect(budgets).toEqual([120, 400, 0]);
  });

  it('SDK timeout terminates the shell process tree and preserves its output', async () => {
    const tool = withBashTimeout(createBashToolDefinition(process.cwd()));
    await expect(tool.execute('x', { command: 'echo before-timeout; sleep 10; echo after-timeout', timeout: 0.3 })).rejects.toThrow('timed out');
  }, 20_000);
});

describe('tool phase diagnostics', () => {
  it('persists JSONL timing records with bounded rotation and tolerates unavailable storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'tokenbird-tool-diagnostics-'));
    try {
      const file = join(root, 'tool-diagnostics.jsonl');
      writeFileSync(file, 'x'.repeat(2_000_000));
      appendToolDiagnostic(root, '{"phase":"execution"}');
      expect(readFileSync(`${file}.previous`, 'utf8')).toHaveLength(2_000_000);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ phase: 'execution' });
      expect(() => appendToolDiagnostic(file, '{}')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records separate durations and failures without argument/output contents', async () => {
    const logs: string[] = [];
    const log = (entry: string) => logs.push(entry);
    expect(await runToolPhase(log, 'call1', 'Bash', 'permission', async () => 'secret result')).toBe('secret result');
    await expect(runToolPhase(log, 'call1', 'Bash', 'execution', async () => { throw new Error('secret argument'); })).rejects.toThrow('secret argument');
    expect(logs).toHaveLength(4);
    expect(logs[1]).toContain('"elapsedMs":');
    expect(logs[1]).toContain('"phase":"permission"');
    expect(logs[3]).toContain('"state":"failed"');
    expect(logs.join()).not.toContain('secret');
  });
});
