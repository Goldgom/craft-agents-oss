import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSearchTools, runSearchProcess } from './local-search.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tokenbird-search-'));
  roots.push(root);
  for (const dir of ['.git', 'service', '.deploy/copy', 'node_modules/lib', 'dist', 'ignored']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  for (const file of ['service/codex.go', '.deploy/copy/codex.go', 'node_modules/lib/codex.go', 'dist/codex.go', 'ignored/codex.go']) writeFileSync(join(root, file), 'has_credits = true\n');
  return root;
}

describe('bounded source searches', () => {
  it('searches sources without deployment, dependency, build or ignored copies; explicit access still works', async () => {
    const root = fixture();
    const rg = Bun.which('rg') || join(import.meta.dir, '../../../../node_modules/@vscode/ripgrep/bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    const [grep, find] = createLocalSearchTools(root, rg);
    const search = await grep!.execute('g', { pattern: 'has_credits', glob: '*.go' });
    const text = JSON.stringify(search.content);
    expect(text).toContain('service');
    for (const dir of ['.deploy', 'node_modules', 'dist', 'ignored']) expect(text).not.toContain(dir);
    const files = await find!.execute('f', { pattern: '*codex*' });
    expect(JSON.stringify(files.content)).toContain('service');
    expect(JSON.stringify(files.content)).not.toContain('.deploy');
    const explicit = await grep!.execute('e', { pattern: 'has_credits', path: '.deploy' });
    expect(JSON.stringify(explicit.content)).toContain('copy');
    const ignored = await grep!.execute('i', { pattern: 'has_credits', includeIgnored: true });
    expect(JSON.stringify(ignored.content)).toContain('node_modules');
    for (const tool of [grep!, find!]) {
      const result = await tool.execute('p', tool.name === 'grep'
        ? { pattern: 'has_credits', glob: 'service/**/*.go' }
        : { pattern: 'service/**/*.go' });
      expect(JSON.stringify(result.content)).toContain('codex.go');
      expect(JSON.stringify(result.content)).not.toContain('node_modules');
    }
  }, 30_000);

  it('retains partial output and terminates a stalled search at its deadline', async () => {
    const result = await runSearchProcess(process.execPath, ['-e', 'console.log("partial match");setInterval(()=>{},1000)'], tmpdir(), { timeoutMs: 400, limit: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.text).toContain('partial match');
  });

  it('bounds output even when one result is huge', async () => {
    const result = await runSearchProcess(process.execPath, ['-e', 'console.log("x".repeat(1000000));setInterval(()=>{},1000)'], tmpdir(), { timeoutMs: 2000, limit: 100 });
    expect(result.limited).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50_000);
    expect(result.timedOut).toBe(false);
  });

  it('enforces the line limit across chunks and keeps a final line without a newline', async () => {
    const result = await runSearchProcess(process.execPath, ['-e', 'console.log("first\\nsecond\\nthird");setInterval(()=>{},1000)'], tmpdir(), { timeoutMs: 2000, limit: 2 });
    expect(result.text).toBe('first\nsecond');
    expect(result.limited).toBe(true);
    const final = await runSearchProcess(process.execPath, ['-e', 'process.stdout.write("last")'], tmpdir(), { timeoutMs: 2000, limit: 100 });
    expect(final.text).toBe('last');
  }, 15_000);

  it('cancels a running search and rejects already cancelled work', async () => {
    const controller = new AbortController();
    const result = runSearchProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), { timeoutMs: 2000, limit: 100, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow('Search cancelled');
    await expect(runSearchProcess('does-not-exist', [], tmpdir(), { timeoutMs: 1000, limit: 100, signal: controller.signal })).rejects.toThrow('Search cancelled');
  });

  it('reports missing ripgrep instead of claiming zero results', async () => {
    const [grep] = createLocalSearchTools(tmpdir());
    await expect(grep!.execute('x', { pattern: 'anything' })).rejects.toThrow('ripgrep is unavailable');
  });
});
