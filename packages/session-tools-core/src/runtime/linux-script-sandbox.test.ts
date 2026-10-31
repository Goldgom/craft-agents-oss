import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinuxSandboxManager } from './linux-script-sandbox.ts';
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

type Result = { code: number; stderr: string };
const ok: Result = { code: 0, stderr: '' };
const missing: Result = { code: 1, stderr: 'not found' };

async function withSession(test: (session: string) => Promise<void>) {
  const session = mkdtempSync(join(tmpdir(), 'linux-sandbox-test-'));
  try { await test(session); } finally { rmSync(session, { recursive: true, force: true }); }
}

describe('Linux sandbox automatic recovery', () => {
  it('uses a verified combined sandbox without installing packages', () => withSession(async session => {
    const calls: string[][] = [];
    const prepare = createLinuxSandboxManager({
      isRoot: () => false, networkNamespace: () => 'net:[host]',
      run: async (command, args) => { calls.push([command, ...args]); return ok; },
    });
    const plan = await prepare('node', ['script.js', 'input with spaces'], session);
    expect(plan.repaired).toBe(false);
    expect(plan.backend).toBe('bwrap');
    expect(plan.args).toContain('--unshare-net');
    expect(plan.args).toContain('--ro-bind');
    expect(plan.args.slice(-3)).toEqual(['node', 'script.js', 'input with spaces']);
    expect(calls).toHaveLength(1);
    // Verification checks the network namespace, a forbidden write and a session write.
    expect(calls[0]!.join(' ')).toContain('readlink /proc/self/ns/net');
    expect(calls[0]!.join(' ')).toContain('/outside');
    expect(calls[0]!.join(' ')).toContain('touch');
  }));

  it('installs a missing backend, verifies it and continues the original command', () => withSession(async session => {
    let installed = false;
    const calls: string[][] = [];
    const prepare = createLinuxSandboxManager({
      isRoot: () => true, networkNamespace: () => 'net:[host]',
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'apt-get') {
          if (args[0] === 'install') installed = true;
          return ok;
        }
        return command === 'bwrap' && installed ? ok : missing;
      },
    });
    const plan = await prepare('python3', ['original.py'], session);
    expect(plan.repaired).toBe(true);
    expect(plan.args.slice(-2)).toEqual(['python3', 'original.py']);
    expect(calls.some(call => call.join(' ') === 'apt-get install -y --no-install-recommends bubblewrap')).toBe(true);
  }));

  it('tries user namespaces and existing firejail before provisioning', () => withSession(async session => {
    const prepare = createLinuxSandboxManager({
      isRoot: () => false, networkNamespace: () => 'net:[host]',
      run: async command => command === 'firejail' ? ok : missing,
    });
    expect((await prepare('node', ['x.js'], session)).backend).toBe('firejail');
  }));

  it('shares installation between concurrent calls and uses noninteractive sudo', () => withSession(async session => {
    let installed = false;
    let installs = 0;
    const prepare = createLinuxSandboxManager({
      isRoot: () => false, networkNamespace: () => 'net:[host]',
      run: async (command, args) => {
        if (command === 'bwrap' && installed) return ok;
        if (command === 'apt-get' || command === 'sudo') {
          if (args.includes('install')) {
            installs++;
            await new Promise(resolve => setTimeout(resolve, 10));
            installed = true;
          }
          return ok;
        }
        return missing;
      },
    });
    const plans = await Promise.all([prepare('node', ['a.js'], session), prepare('node', ['b.js'], session)]);
    expect(installs).toBe(1);
    expect(plans.every(plan => plan.repaired)).toBe(true);
  }));

  it('never executes the payload if installed backends fail verification', () => withSession(async session => {
    const calls: string[][] = [];
    const prepare = createLinuxSandboxManager({
      isRoot: () => true, networkNamespace: () => 'net:[host]',
      run: async (command, args) => {
        calls.push([command, ...args]);
        return command === 'apt-get' ? ok : { code: 1, stderr: 'Operation not permitted' };
      },
    });
    await expect(prepare('node', ['must-not-run.js'], session)).rejects.toThrow('after automatic repair');
    expect(calls.flat()).not.toContain('must-not-run.js');
    expect(calls.filter(call => call[0] === 'bwrap')).toHaveLength(4);
  }));

  it('reports missing privileges and avoids repeated installation attempts', () => withSession(async session => {
    let sudoCalls = 0;
    const prepare = createLinuxSandboxManager({
      isRoot: () => false, networkNamespace: () => 'net:[host]',
      run: async command => { if (command === 'sudo') sudoCalls++; return missing; },
    });
    await expect(prepare('node', [], session)).rejects.toThrow('root or passwordless sudo');
    await expect(prepare('node', [], session)).rejects.toThrow('root or passwordless sudo');
    expect(sudoCalls).toBe(1);
  }));

  it.skipIf(process.platform !== 'linux' || process.env.TOKENBIRD_TEST_LINUX_SANDBOX !== '1')(
    'executes in a real sandbox with network isolation and session-only writes',
    () => withSession(async session => {
      const outside = mkdtempSync(join(tmpdir(), 'sandbox-outside-'));
      try {
        const script = `const fs = require('node:fs');
          if (fs.readlinkSync('/proc/self/ns/net') === ${JSON.stringify(readlinkSync('/proc/self/ns/net'))}) throw Error('shared network');
          let blocked = false;
          try { fs.writeFileSync(${JSON.stringify(join(outside, 'forbidden'))}, 'no'); } catch { blocked = true; }
          if (!blocked) throw Error('outside write allowed');
          fs.writeFileSync(${JSON.stringify(join(session, 'allowed'))}, 'isolated');
          console.log('sandbox-ok');`;
        const prepare = createLinuxSandboxManager();
        const plan = await prepare(process.env.TOKENBIRD_NODE || process.execPath, ['-e', script], session);
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(plan.command, plan.args, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}`));
            else resolve(stdout);
          });
        });
        expect(stdout).toContain('sandbox-ok');
        expect(readFileSync(join(session, 'allowed'), 'utf8')).toBe('isolated');
      } finally { rmSync(outside, { recursive: true, force: true }); }
    }), 120_000,
  );
});
