import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleComputerUse, type ComputerUseArgs, type SessionToolContext } from '@craft-agent/session-tools-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.platform !== 'win32') throw new Error('This smoke test requires an unlocked Windows desktop.');
const root = resolve(import.meta.dir, '..');
const packagedApp = process.argv[2] ? resolve(process.argv[2]) : undefined;
process.env.CRAFT_SCRIPTS = join(packagedApp || join(root, 'apps/electron'), 'resources/scripts');
const directory = await mkdtemp(join(tmpdir(), 'tokenbird-desktop-test-'));
const statePath = join(directory, 'state.json');
const closePath = join(directory, 'close');
const title = `TokenBird Computer Use Test ${Date.now()}`;
const checks: string[] = [];
async function call(input: ComputerUseArgs) {
  const result = await handleComputerUse({} as SessionToolContext, input);
  if (result.isError) throw new Error(`${input.action}: ${result.content[0].text}`);
  return { result, data: JSON.parse(result.content[0].text) };
}
const status = await call({ action: 'status' });
if (!status.data.available) throw new Error('Unlock the Windows desktop before running this test.');
checks.push('interactive desktop');
const previous = (await call({ action: 'windows' })).data.windows.find((w: any) => w.foreground)?.windowId;
const child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  join(root, 'packages/session-tools-core/src/handlers/test-fixtures/computer-use-window.ps1'),
  '-StatePath', statePath, '-ClosePath', closePath, '-WindowTitle', title,
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let childError = '';
child.stderr?.on('data', chunk => { childError += chunk.toString(); });
const exited = new Promise<void>((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', () => resolveExit());
});
try {
  let windowId: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    windowId = (await call({ action: 'windows' })).data.windows.find((w: any) => w.title === title)?.windowId;
    if (windowId) break;
    if (child.exitCode !== null) throw new Error(childError || 'Test window exited before becoming ready');
    await new Promise(r => setTimeout(r, 200));
  }
  if (!windowId) {
    const state = await readFile(statePath, 'utf8').catch(() => 'no fixture state');
    throw new Error(childError || `Test window was not found: ${state}`);
  }
  await call({ action: 'focus', windowId });
  checks.push('window listing and focus');
  const snapshot = (await call({ action: 'snapshot', windowId })).data;
  const find = (name: string) => {
    const element = snapshot.elements.find((e: any) => e.name === name
      || (name === 'Test input' && /WindowsForms.*\.EDIT\./.test(e.className))
      || (name === 'Drag area' && /WindowsForms.*\.Window\./.test(e.className) && e.height === 100));
    if (!element) throw new Error(`Missing UI Automation element: ${name}; snapshot=${JSON.stringify(snapshot)}`);
    return element;
  };
  const input = find('Test input');
  const button = find('Test click');
  const drag = find('Drag area');
  const point = (element: any) => ({ x: Math.round(element.x + element.width / 2), y: Math.round(element.y + element.height / 2) });
  checks.push('UI Automation');
  const shot = await call({ action: 'screenshot', maxWidth: 1200 });
  const bytes = Buffer.from(shot.result.images?.[0]?.data || '', 'base64');
  if (bytes.subarray(1, 4).toString() !== 'PNG' || bytes.readUInt32BE(16) !== shot.data.imageWidth
    || bytes.readUInt32BE(20) !== shot.data.imageHeight || shot.data.imageWidth > 1200) throw new Error('Invalid screenshot or coordinate metadata');
  checks.push('PNG screenshot and scaling');
  await call({ action: 'click', ...point(button) });
  await call({ action: 'click', ...point(input) });
  await call({ action: 'type', text: 'replace this' });
  await call({ action: 'key', keys: 'CTRL+A' });
  const literal = '中文 TokenBird "quoted" ` $() ; & 😀\n第二行';
  await call({ action: 'type', text: literal });
  await call({ action: 'scroll', ...point(input), delta: -120 });
  await call({ action: 'drag', x: Math.round(drag.x + 20), y: Math.round(drag.y + 30),
    toX: Math.round(drag.x + 150), toY: Math.round(drag.y + 60), durationMs: 200 });
  const position = (await call({ action: 'position' })).data;
  if (position.x !== Math.round(drag.x + 150) || position.y !== Math.round(drag.y + 60)) throw new Error('Pointer position differs from drag destination');
  await call({ action: 'wait', durationMs: 250 });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.text.replace(/\r\n/g, '\n') !== literal) throw new Error('Unicode/literal typing or CTRL+A did not reach the test window');
  if (state.clicks !== 1 || state.drags !== 1 || state.wheelCount < 1) throw new Error(`Input delivery mismatch: ${JSON.stringify(state)}`);
  checks.push('click, drag, scroll, shortcut, Unicode and literal text');
  const invalid = await handleComputerUse({} as SessionToolContext, { action: 'click', x: 1000000, y: 1000000 });
  if (!invalid.isError) throw new Error('Out-of-bounds input was accepted');
  checks.push('out-of-bounds rejection');
  // Exercise the actual compiled MCP adapter and bundled runtime, including
  // screenshot image blocks crossing stdio rather than only the core handler.
  const client = new Client({ name: 'desktop-smoke', version: '1' });
  const transport = new StdioClientTransport({
    command: packagedApp ? join(packagedApp, '..', 'vendor/bun/bun.exe') : process.execPath,
    args: [packagedApp ? join(packagedApp, 'resources/session-mcp-server/index.js') : join(root, 'packages/session-mcp-server/dist/index.js'),
      '--session-id', 'desktop-smoke', '--workspace-root', directory, '--plans-folder', directory],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(t => t.name === 'computer_use')) throw new Error('Compiled MCP server did not register computer_use');
    const capture = await client.callTool({ name: 'computer_use', arguments: { action: 'screenshot', maxWidth: 640 } });
    if (capture.isError || !(capture.content as any[]).some(c => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 100)) {
      throw new Error('Compiled MCP server did not return a screenshot image block');
    }
    checks.push('compiled MCP registration and screenshot image transport');
  } finally { await client.close(); }
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await writeFile(closePath, 'close');
  await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
  if (child.exitCode === null) child.kill();
  await exited;
  if (previous) await call({ action: 'focus', windowId: previous }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
