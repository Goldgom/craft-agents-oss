import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { superAgentScriptOperation } from '@craft-agent/shared/super-agent';
import { superAgentFixture, until } from './SuperAgentTestSupport';

test('production dispatch carries mandatory gates and original user intent without exposing hidden rules', async () => {
  const f = await superAgentFixture({ actionGates: true });
  f.config.environment.safety = { autoReview: true, customRules: [{ toolName: 'Write', effect: 'deny', reason: 'Read-only engagement' }] };
  await f.service.save('alpha', f.config);
  await f.service.command('alpha', { type: 'chat', text: 'Draft the reply. Do not send it.' });
  await until(() => f.service.get('alpha'), () => f.host.sends.length > 0);
  const policy = f.host.policies.get(f.host.sends[0]!.sessionId)!;
  expect(policy.actionGates).toBe(true);
  expect(policy.userIntent).toBe('Draft the reply. Do not send it.');
  expect(policy.safety?.customRules[0]?.effect).toBe('deny');
  expect(f.host.sends[0]!.message).toBe('Draft the reply. Do not send it.');
  expect(f.host.sends[0]!.context).toContain('Read-only engagement');
});

test('model final actions cannot start scripts even without a task assignment', async () => {
  let launches = 0;
  const f = await superAgentFixture({ actionGates: true, spawnScript: async () => { launches++; throw new Error('Must not launch'); } });
  await writeFile(join(f.workingDirectory, 'script.js'), 'console.log("approved entry");');
  f.config.scripts = [{ id: 'script', name: 'Script', path: 'script.js', args: [], nodeId: 'worker', timeoutSeconds: 5 }];
  await f.service.save('alpha', f.config);
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Prepare the script; request approval before running.' });
  await until(() => f.service.get('alpha'), () => f.host.sends.length > 0);
  f.host.complete(f.host.sends[0]!.sessionId, '<super_agent_actions>{"runScripts":["script"]}</super_agent_actions>');
  const snapshot = await until(() => f.service.get('alpha'), state => state.state.messages.some(message => message.actionReceipt?.rejected?.type === 'script-run'));
  expect(snapshot.state.messages.find(message => message.actionReceipt?.rejected?.type === 'script-run')!.actionReceipt!.rejected!.error).toContain('Action Gate');
  expect(launches).toBe(0);
});

test('manual script approval binds content, arguments and environment and passes captured bytes to the adapter', async () => {
  let launches = 0, captured = '';
  const f = await superAgentFixture({ actionGates: true,
    resolveEnvironment: async (_id, environment) => ({ workingDirectory: environment.workingDirectory, status: { available: true, isolation: 'container', detail: 'Test adapter' } }),
    spawnScript: async input => {
      launches++; captured = input.approvedContent!.toString();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], { windowsHide: true });
      return { child, stop: async () => { child.kill(); } };
    },
  });
  const content = 'console.log("approved entry");';
  await writeFile(join(f.workingDirectory, 'script.js'), content);
  const script = { id: 'script', name: 'Script', path: 'script.js', args: ['--report'], nodeId: 'worker', timeoutSeconds: 5 };
  f.config.environment.kind = 'sandbox'; f.config.environment.sandbox = { runtime: 'docker', image: 'node:22' };
  f.config.scripts = [script];
  await f.service.save('alpha', f.config);
  const approval = { sha256: createHash('sha256').update(content).digest('hex'), operation: superAgentScriptOperation(f.config.environment, script) };
  await expect(f.service.command('alpha', { type: 'script-run', scriptId: 'script' })).rejects.toThrow('refresh and approve');
  await writeFile(join(f.workingDirectory, 'script.js'), 'changed');
  await expect(f.service.command('alpha', { type: 'script-run', scriptId: 'script', approval })).rejects.toThrow('refresh and approve');
  await writeFile(join(f.workingDirectory, 'script.js'), content);
  await expect(f.service.command('alpha', { type: 'script-run', scriptId: 'script', approval: { ...approval, operation: 'different environment or arguments' } })).rejects.toThrow('refresh and approve');
  expect(launches).toBe(0);
  await f.service.command('alpha', { type: 'script-run', scriptId: 'script', approval });
  expect(launches).toBe(1); expect(captured).toBe(content);
});

test.each(['manual', 'node'] as const)('full control starts a %s script without an approval descriptor', async mode => {
  let launches = 0, captured = '';
  const f = await superAgentFixture({ actionGates: true,
    resolveEnvironment: async (_id, environment) => ({ workingDirectory: environment.workingDirectory, status: { available: true, isolation: 'container', detail: 'Test adapter' } }),
    spawnScript: async input => {
      launches++; captured = input.approvedContent!.toString();
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], { windowsHide: true });
      return { child, stop: async () => { child.kill(); } };
    },
  });
  f.config.environment.kind = 'sandbox'; f.config.environment.sandbox = { runtime: 'docker', image: 'node:22' };
  f.config.environment.fullControl = true;
  f.config.environment.permissions.runPrograms = false;
  f.config.environment.safety = { autoReview: true, customRules: [{ toolName: 'script-run', effect: 'require-human', reason: 'Review programs' }] };
  f.config.scripts = [{ id: 'script', name: 'Script', path: 'script.js', args: [], nodeId: 'worker', timeoutSeconds: 5 }];
  await writeFile(join(f.workingDirectory, 'script.js'), 'console.log("direct entry");');
  await f.service.save('alpha', f.config);
  if (mode === 'manual') await f.service.command('alpha', { type: 'script-run', scriptId: 'script' });
  else {
    await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Run script', instructions: 'Run the registered script directly' });
    await until(() => f.service.get('alpha'), () => f.host.sends.length > 0);
    f.host.complete(f.host.sends[0]!.sessionId, '<super_agent_actions>{"runScripts":["script"]}</super_agent_actions>');
    await until(() => f.service.get('alpha'), state => state.state.messages.some(message => message.actionReceipt?.applied.some(action => action.type === 'script-run')));
  }
  expect(launches).toBe(1); expect(captured).toBe('console.log("direct entry");');
});

test('full control still requires a verified container for scripts', async () => {
  const f = await superAgentFixture({ actionGates: true });
  f.config.environment.fullControl = true;
  f.config.scripts = [{ id: 'script', name: 'Script', path: 'script.js', args: [], timeoutSeconds: 5 }];
  await writeFile(join(f.workingDirectory, 'script.js'), 'console.log("host");');
  await f.service.save('alpha', f.config);
  await expect(f.service.command('alpha', { type: 'script-run', scriptId: 'script' })).rejects.toThrow('verified container sandbox');
});
