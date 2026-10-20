import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { headlessRuntimePlugin } from './headless-runtime.ts';

it.each([
  { mode: 'tokenbird', restricted: false },
  { mode: 'tokenbird', restricted: true },
  { mode: 'off', restricted: false },
  { mode: 'native', restricted: false },
])('routes packaged compaction and respects memory mode %j', async ({mode, restricted}) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-compaction-routing-'));
  const requested: string[] = [];
  let lunaCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requested.push(body.model);
    if (body.model === 'selected') {
      response.writeHead(404, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: {message: 'model_not_found', code: 'model_not_found'}}));
      return;
    }
    const truncated = body.model === 'luna' && ++lunaCalls === 1;
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    response.end(`data: ${JSON.stringify({id: 'local', choices: [{index: 0, delta: {role: 'assistant', content:
      truncated ? 'Partial' : 'Complete checkpoint: preserve pending task TASK-123.'}, finish_reason: truncated ? 'length' : 'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const runtime = headlessRuntimePlugin();
    const build = await Bun.build({entrypoints: [resolve(import.meta.dir, '../src/index.ts')], outdir: directory,
      target: 'bun', format: 'esm', external: ['koffi'], plugins: [runtime.plugin]});
    expect(build.success).toBe(true);
    runtime.assertApplied();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local address');
    const customModels = ['chat', 'selected', 'luna', 'haiku', 'last'];
    const connection = {model: 'chat', providerType: 'pi_compat', authType: 'api_key',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, customEndpoint: {api: 'openai-completions'},
      customModels, autoCompactionTokenLimit: 4_000};
    child = spawn(process.execPath, ['--no-install', join(directory, 'index.js')], {cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, TOKENBIRD_CONFIG_DIR: directory, TOKENBIRD_MEMORY_MODE: mode, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost'}});
    const running = child;
    const send = (message: object) => running.stdin!.write(JSON.stringify(message) + '\n');
    let phase = 0;
    let turns = 0;
    let stderr = '';
    const errors: string[] = [];
    const results: any[] = [];
    running.stderr!.on('data', chunk => {stderr = (stderr + chunk).slice(-4_096);});
    const lines = createInterface({input: running.stdout!});
    const prompt = () => send({type: 'prompt', id: `turn-${phase}-${turns}`, systemPrompt: 'Reply briefly.',
      message: `Pending TASK-123, phase ${phase}, turn ${turns}: ${'source facts '.repeat(500)}`});
    const finished = new Promise<number | null>((resolve, reject) => {
      running.once('error', reject);
      running.once('exit', resolve);
    });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'ready') send({type: 'set_auto_compaction', id: 'disable-auto', enabled: false});
      if (message.type === 'set_auto_compaction_result') prompt();
      if (message.type === 'error') errors.push(message.message);
      if (message.type === 'event' && message.event.type === 'agent_end') {
        setTimeout(() => {
          if (++turns < 4) prompt();
          else send({type: 'compact', id: `compact-${phase}`});
        }, 0);
      }
      if (message.type === 'compact_result') {
        results.push(message);
        if (!message.success || ++phase === 3) send({type: 'shutdown'});
        else {
          turns = 0;
          const list = phase === 1 ? ['chat', 'haiku', 'last'] : ['chat', 'last'];
          send({type: 'update_runtime_config', id: `update-${phase}`, ...connection,
            compactionModel: '', compactionModels: list.map(id => ({id, name: id}))});
        }
      }
      if (message.type === 'update_runtime_config_result') {
        if (message.success) prompt();
        else {errors.push(message.errorMessage); send({type: 'shutdown'});}
      }
    });
    send({type: 'init', apiKey: 'local-test', ...connection, compactionModel: 'selected',
      compactionModels: customModels.map(id => ({id, name: id})),
      piAuth: {provider: 'openai', credential: {type: 'api_key', key: 'local-test'}},
      cwd: directory, workspaceRootPath: directory, sessionId: 'compaction-probe', sessionPath: join(directory, 'session'),
      workingDirectory: directory, plansFolderPath: directory, browserToolOnly: restricted, interactionOnly: restricted});
    const timer = setTimeout(() => running.kill(), 45_000);
    try {
      expect(await finished, stderr).toBe(0);
      expect(errors, stderr).toEqual([]);
      expect(results).toHaveLength(3);
      expect(results.every(result => result.success)).toBe(true);
      expect(requested.filter(id => id !== 'chat')).toEqual(['selected', 'luna', 'luna', 'haiku', 'last']);
      const archiveDir = join(directory, 'session', 'memory', 'compactions');
      if (mode === 'tokenbird' && !restricted) {
        const archives = readdirSync(archiveDir);
        expect(archives).toHaveLength(3);
        for (const result of results) expect(result.result.summary).toContain('Session memory:');
        expect(archives.map(file => readFileSync(join(archiveDir, file), 'utf8')).join('\n')).toContain('Pending TASK-123');
      } else {
        expect(existsSync(archiveDir)).toBe(false);
        for (const result of results) expect(result.result.summary).not.toContain('Session memory:');
      }
    } finally {clearTimeout(timer); lines.close();}
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, {recursive: true, force: true});
  }
}, 60_000);
