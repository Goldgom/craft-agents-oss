import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

const testTool = {
  name: 'mcp__session__test',
  description: 'Test tool',
  inputSchema: { type: 'object', properties: {} },
};

describe('PiAgent tool registration startup barrier', () => {
  it('does not complete registration until the matching subprocess ACK arrives', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);

    let settled = false;
    const registration = (agent as any).requestRegisterTools([testTool]) as Promise<{
      count: number;
      total: number;
    }>;
    registration.finally(() => { settled = true; });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('register_tools');
    expect(typeof sent[0]!.id).toBe('string');

    await Promise.resolve();
    expect(settled).toBe(false);

    (agent as any).handleLine(JSON.stringify({
      type: 'tools_registered',
      id: sent[0]!.id,
      count: 1,
      total: 7,
    }));

    await expect(registration).resolves.toEqual({ count: 1, total: 7 });
    expect((agent as any).pendingToolRegistrations.size).toBe(0);
    agent.destroy();
  });

  it('ignores unrelated ACKs and keeps waiting for its own registration ID', async () => {
    const agent = new PiAgent(createConfig());
    const sent: Array<Record<string, unknown>> = [];
    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);

    let settled = false;
    const registration = (agent as any).requestRegisterTools([testTool]) as Promise<unknown>;
    registration.finally(() => { settled = true; });

    (agent as any).handleLine(JSON.stringify({
      type: 'tools_registered',
      id: 'register-tools-unrelated',
      count: 1,
      total: 1,
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    (agent as any).handleLine(JSON.stringify({
      type: 'tools_registered',
      id: sent[0]!.id,
      count: 1,
      total: 1,
    }));
    await registration;
    agent.destroy();
  });

  it('rejects an in-flight registration if the subprocess exits', async () => {
    const agent = new PiAgent(createConfig());
    (agent as any).send = () => {};

    const registration = (agent as any).requestRegisterTools([testTool]) as Promise<unknown>;
    (agent as any).handleSubprocessExit(1, null);

    await expect(registration).rejects.toThrow(/subprocess exited/i);
    expect((agent as any).pendingToolRegistrations.size).toBe(0);
    agent.destroy();
  });

  it('shares one complete startup promise across concurrent callers', async () => {
    const agent = new PiAgent(createConfig());
    let spawnCalls = 0;
    let finishStartup!: () => void;
    (agent as any).spawnSubprocess = () => {
      spawnCalls++;
      return new Promise<void>((resolve) => { finishStartup = resolve; });
    };

    let secondSettled = false;
    const first = (agent as any).ensureSubprocess() as Promise<void>;
    const second = (agent as any).ensureSubprocess() as Promise<void>;
    second.finally(() => { secondSettled = true; });

    expect(spawnCalls).toBe(1);
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishStartup();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    agent.destroy();
  });
});
