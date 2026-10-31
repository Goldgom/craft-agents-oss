import { describe, expect, it } from 'bun:test';
import { piDriver } from './pi.ts';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DriverBuildArgs } from '../driver-types.ts';
import { stream as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model } from '@earendil-works/pi-ai';

describe('TokenNest group request headers', () => {
  function runtimeForGroup(group: string, oauthProvider = 'tokennest') {
    return piDriver.buildRuntime({
      context: {
        connection: { oauthProvider, channelGroup: group },
      },
      resolvedPaths: {},
    } as DriverBuildArgs);
  }

  it('keeps group headers scoped to TokenNest', () => {
    expect(runtimeForGroup('Normal').customHeaders?.['X-TokenNest-Group']).toBe('Normal');
    expect(runtimeForGroup('中文', 'other').customHeaders).toBeUndefined();
    expect(runtimeForGroup('').customHeaders).toBeUndefined();
  });

  it('sends Chinese group IDs as the exact UTF-8 bytes expected by the gateway', async () => {
    const group = '大肥鱼清仓大甩卖';
    let received = '';
    const server = createServer((req, res) => {
      received = Buffer.from(String(req.headers['x-tokennest-group']), 'latin1').toString('utf8');
      res.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const headers = new Headers(runtimeForGroup(group).customHeaders);
      const response = await fetch(`http://127.0.0.1:${address.port}`, { headers });
      expect(await response.text()).toBe('ok');
      expect(received).toBe(group);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves Chinese group bytes through the real Pi OpenAI streaming client', async () => {
    const group = '大肥鱼清仓大甩卖';
    let received = '';
    const server = createServer((req, res) => {
      received = Buffer.from(String(req.headers['x-tokennest-group']), 'latin1').toString('utf8');
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const model: Model<'openai-completions'> = {
        id: 'gpt-4o', name: 'Test', api: 'openai-completions', provider: 'openai',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024,
        headers: runtimeForGroup(group).customHeaders,
      };
      const result = await streamOpenAI(model, {
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      }, { apiKey: 'local-test' }).result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(received).toBe(group);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('propagates the packaged host ripgrep path to the Pi runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'tokenbird-pi-tooling-'));
    const binary = join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    try {
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, 'fixture');
      const runtime = piDriver.buildRuntime({
        context: { connection: null }, resolvedPaths: {},
        hostRuntime: { appRootPath: root, isPackaged: true },
      } as DriverBuildArgs);
      expect(runtime.paths?.ripgrep).toBe(binary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        agentRuntime: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: { appRootPath: process.cwd(), isPackaged: false },
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});
