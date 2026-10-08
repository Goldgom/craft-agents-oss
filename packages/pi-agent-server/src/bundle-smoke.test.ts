import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Smoke test against the BUILT single-file bundle, not the source tree.
 *
 * Two 0.12.1 release breakages were invisible to source-mode tests because they
 * only exist in the bundled artifact or in the exact server injection path:
 *   1. "No API key found for openai-codex" — api_key credential shipped for an
 *      OAuth-only provider (pi SDK ≥0.81 typed resolver).
 *   2. "OAuth auth derivation failed" — lazyOAuth's bundler-opaque dynamic
 *      import cannot resolve flow modules next to a single-file bundle.
 *
 * This drives dist/index.js over its JSONL protocol from a directory outside
 * the repo (so nothing resolves from node_modules) with a ChatGPT Plus-shaped
 * init, and asserts the prompt gets past credential resolution and OAuth
 * derivation all the way to request building. The fake token is deliberately
 * not a JWT: failing at accountId extraction is the deterministic, offline
 * proof that the whole auth pipeline upstream of the HTTP request works.
 */

const packageDir = dirname(import.meta.dir);
const bundlePath = join(packageDir, 'dist', 'index.js');
const blockNetworkPreloadPath = join(import.meta.dir, 'test-fixtures', 'block-network.ts');
const RUN_TIMEOUT_MS = 30_000;

let scratchDir: string;

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { cwd: packageDir, stdio: 'pipe', timeout: 120_000 });
  if (build.status !== 0) {
    throw new Error(`bundle build failed: ${build.stderr?.toString() ?? build.stdout?.toString()}`);
  }
  scratchDir = mkdtempSync(join(tmpdir(), 'pi-bundle-smoke-'));
  mkdirSync(join(scratchDir, 'plans'), { recursive: true });
});

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * Build an allowlisted subprocess environment. Besides keeping the smoke test
 * independent of the developer machine, this prevents ambient provider keys,
 * auth files, custom base URLs, and proxy/routing variables from bypassing the
 * fake credential or escaping the explicit network guard.
 */
function createOfflineEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    XDG_CONFIG_HOME: scratchDir,
    TMPDIR: scratchDir,
    TEMP: scratchDir,
    TMP: scratchDir,
  };

  // Keep only variables required to launch Bun on each supported platform.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Spawn the bundle, send JSONL messages, and collect output until `done` matches or timeout. */
function driveBundle(
  messages: object[], done: (output: string) => boolean, afterReady: object[] = [],
  options: { preload?: string; onMessage?: (message: Record<string, any>) => object[] } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--preload', options.preload ?? blockNetworkPreloadPath, bundlePath], {
      cwd: scratchDir,
      env: createOfflineEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let protocolBuffer = '';
    let sentAfterReady = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for terminal marker; output so far:\n${output.slice(-2000)}`)),
      RUN_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (options.onMessage) {
        protocolBuffer += chunk.toString();
        const lines = protocolBuffer.split('\n');
        protocolBuffer = lines.pop() ?? '';
        for (const line of lines) {
          let message: Record<string, any>;
          try { message = JSON.parse(line); } catch { continue; }
          for (const command of options.onMessage(message)) child.stdin.write(`${JSON.stringify(command)}\n`);
        }
      }
      if (!sentAfterReady && output.includes('"type":"ready"')) {
        sentAfterReady = true;
        for (const msg of afterReady) child.stdin.write(`${JSON.stringify(msg)}\n`);
      }
      if (done(output)) finish();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(err));
    child.on('exit', () => {
      if (!done(output)) finish(new Error(`bundle exited early; output:\n${output.slice(-2000)}`));
    });
    for (const msg of messages) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  });
}

describe('pi-agent-server bundle', () => {
  for (const [browserToolOnly, interactionOnly] of [[true, false], [false, false], [true, true]]) {
    it(interactionOnly ? 'advertises only messaging for the interaction node' : `advertises browser_tool with native web tools ${browserToolOnly ? 'hidden for nodes' : 'retained for ordinary sessions'}`, async () => {
      const output = await driveBundle([{
        type: 'init', apiKey: '', model: 'browser-policy-test', cwd: scratchDir,
        workspaceRootPath: scratchDir, sessionId: `bundle-browser-policy-${browserToolOnly}-${interactionOnly}`,
        sessionPath: scratchDir, workingDirectory: scratchDir, plansFolderPath: join(scratchDir, 'plans'),
        providerType: 'pi_compat', authType: 'api_key', browserToolOnly, interactionOnly,
        baseUrl: 'https://browser-policy.invalid/v1', customEndpoint: { api: 'openai-completions' },
        customModels: ['browser-policy-test'],
        piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'dummy-offline' } },
      }], out => out.includes('"type":"test_browser_tool_policy"'), [
        { type: 'register_tools', id: 'browser-tools', tools: [{
          name: 'mcp__session__browser_tool', description: 'Read a page using the session browser.',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        }, {
          name: 'mcp__session__send_agent_message', description: 'Send requirements to an existing worker.',
          inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, message: { type: 'string' } } },
        }, {
          name: 'mcp__assigned__query', description: 'Query external data.', inputSchema: { type: 'object' },
        }] },
        { type: 'prompt', id: 'browser-prompt', message: 'Read the assigned page.', systemPrompt: 'Use browser_tool.' },
      ], { preload: join(import.meta.dir, 'test-fixtures', 'assert-browser-tool-policy.ts') });
      const packet = output.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } })
        .find(message => message?.type === 'test_browser_tool_policy');
      if (interactionOnly) {
        expect(packet.tools).toEqual(['mcp__session__send_agent_message']);
        return;
      }
      expect(packet.tools).toContain('mcp__session__browser_tool');
      expect(packet.tools).toContain('read');
      expect(packet.tools.includes('web_fetch')).toBe(!browserToolOnly);
      expect(packet.tools.includes('web_search')).toBe(!browserToolOnly);
    });
  }

  it('awaits a TokenNest refresh ACK and sends the replacement token to a custom endpoint', async () => {
    let refreshId = '';
    let refreshed = false;
    const output = await driveBundle([{
      type: 'init', apiKey: '', model: 'auth-test', cwd: scratchDir,
      workspaceRootPath: scratchDir, sessionId: 'bundle-tokennest-refresh',
      sessionPath: scratchDir, workingDirectory: scratchDir,
      plansFolderPath: join(scratchDir, 'plans'), providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', baseUrl: 'https://tokennest.invalid/v1',
      customEndpoint: { api: 'openai-completions' }, customModels: ['auth-test'],
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'dummy-old' } },
    }], out => out.includes('"type":"test_wire_auth"'), [
      { type: 'prompt', id: 'p1', message: 'hi', systemPrompt: 'Offline test.' },
    ], {
      preload: join(import.meta.dir, 'test-fixtures', 'assert-token-rotation.ts'),
      onMessage(message) {
        if (message.type === 'auth_refresh_request') {
          if (refreshed) return [{ type: 'auth_refresh_result', id: message.id, success: true }];
          refreshId = message.id;
          return [{ type: 'token_update', id: 'test-rotation', piAuth: {
            provider: 'openai', credential: { type: 'api_key', key: 'dummy-replacement' },
          } }];
        }
        if (message.type === 'token_update_result' && message.id === 'test-rotation' && message.success) {
          refreshed = true;
          return [{ type: 'auth_refresh_result', id: refreshId, success: true }];
        }
        return [];
      },
    });
    expect(refreshed).toBe(true);
    expect(output).toContain('"type":"test_wire_auth","fresh":true');
    expect(output).not.toContain('"fresh":false');
    expect(output).not.toContain('dummy-replacement');
  }, RUN_TIMEOUT_MS + 130_000);

  it('acknowledges credential updates by request id in the built runtime', async () => {
    const output = await driveBundle(
      [{
        type: 'init', apiKey: '', model: 'pi/gpt-6-astra', cwd: scratchDir,
        workspaceRootPath: scratchDir, sessionId: 'bundle-auth-ack',
        sessionPath: scratchDir, workingDirectory: scratchDir,
        plansFolderPath: join(scratchDir, 'plans'), providerType: 'pi', authType: 'oauth',
        piAuth: { provider: 'openai-codex', credential: { type: 'api_key', key: 'dummy-old' } },
      }],
      out => out.includes('"id":"auth-accepted","success":true') && out.includes('"id":"auth-rejected","success":false'),
      [
        { type: 'token_update', id: 'auth-accepted', piAuth: { provider: 'openai-codex', credential: { type: 'api_key', key: 'dummy-replacement' } } },
        { type: 'token_update', id: 'auth-rejected', piAuth: { provider: 'amazon-bedrock', credential: { type: 'iam', accessKeyId: 'dummy-id', secretAccessKey: 'dummy-secret' } } },
      ],
    );
    expect(output).not.toContain('dummy-replacement');
    expect(output).not.toContain('dummy-secret');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
  }, RUN_TIMEOUT_MS + 130_000);

  it('resolves a ChatGPT Plus credential for Astra through the bundled auth pipeline offline', async () => {
    const output = await driveBundle(
      [
        {
          type: 'init',
          apiKey: '',
          model: 'pi/gpt-6-astra',
          cwd: scratchDir,
          thinkingLevel: 'off',
          workspaceRootPath: scratchDir,
          sessionId: 'bundle-smoke',
          sessionPath: scratchDir,
          workingDirectory: scratchDir,
          plansFolderPath: join(scratchDir, 'plans'),
          providerType: 'pi',
          authType: 'oauth',
          piAuth: { provider: 'openai-codex', credential: { type: 'api_key', key: 'fake-not-a-jwt' } },
        },
        { type: 'prompt', id: 'p1', message: 'hi', systemPrompt: 'You are a smoke test.' },
      ],
      // The non-JWT token must fail exactly at request-build accountId extraction —
      // any earlier failure is one of the auth-pipeline regressions this test pins.
      (out) => out.includes('Failed to extract accountId from token') ||
        out.includes('OFFLINE_FETCH_BLOCKED') ||
        out.includes('No API key found') ||
        out.includes('OAuth auth derivation failed'),
    );

    expect(output).not.toContain('No API key found');
    expect(output).not.toContain('OAuth auth derivation failed');
    expect(output).not.toContain('Cannot find module');
    expect(output).not.toContain('OFFLINE_FETCH_BLOCKED');
    expect(output).toContain('Failed to extract accountId from token');
  }, RUN_TIMEOUT_MS + 130_000);
});
