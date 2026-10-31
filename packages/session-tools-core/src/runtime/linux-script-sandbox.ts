import { execFile } from 'node:child_process';
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSanitizedEnv } from './sandbox-env.ts';

interface CommandResult { code: number; stderr: string }
type Run = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

const runCommand: Run = (command, args, timeoutMs) => new Promise(resolveResult => {
  execFile(command, args, {
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { ...createSanitizedEnv(), DEBIAN_FRONTEND: 'noninteractive' },
  }, (error, stdout, stderr) => {
    resolveResult({ code: error ? 1 : 0, stderr: String(stderr || stdout || error?.message || '').slice(-2000) });
  });
});

export interface LinuxScriptSandbox {
  backend: 'bwrap' | 'firejail';
  command: string;
  args: string[];
  repaired: boolean;
}

interface SandboxDependencies {
  run: Run;
  isRoot: () => boolean;
  networkNamespace: () => string;
}

/** One provisioner per host process: concurrent sessions share dependency installation. */
export function createLinuxSandboxManager(deps: SandboxDependencies = {
  run: runCommand, isRoot: () => process.getuid?.() === 0,
  networkNamespace: () => readlinkSync('/proc/self/ns/net'),
}) {
  let provisioning: Promise<string> | undefined;
  let lastProvisionedAt = 0;
  let provisioningResult = '';

  async function installBubblewrap(): Promise<string> {
    let prefix: string[] = [];
    if (!deps.isRoot()) {
      const sudo = await deps.run('sudo', ['-n', 'true'], 5000);
      if (sudo.code !== 0) return `Automatic installation needs root or passwordless sudo: ${sudo.stderr}`;
      prefix = ['sudo', '-n'];
    }
    const managers = [
      { name: 'apt-get', steps: [['install', '-y', '--no-install-recommends', 'bubblewrap']] },
      { name: 'dnf', steps: [['install', '-y', 'bubblewrap']] },
      { name: 'yum', steps: [['install', '-y', 'bubblewrap']] },
      { name: 'apk', steps: [['add', '--no-cache', 'bubblewrap']] },
      { name: 'pacman', steps: [['-S', '--noconfirm', '--needed', 'bubblewrap']] },
      { name: 'zypper', steps: [['--non-interactive', 'install', 'bubblewrap']] },
    ];
    for (const manager of managers) {
      if ((await deps.run(manager.name, ['--version'], 5000)).code !== 0) continue;
      const deadline = Date.now() + 90_000;
      for (const step of manager.steps) {
        const command = prefix[0] ?? manager.name;
        const args = prefix.length ? [...prefix.slice(1), manager.name, ...step] : step;
        let result = await deps.run(command, args, Math.max(1, deadline - Date.now()));
        // Most servers already have package indexes. Refresh only when needed.
        if (result.code !== 0 && manager.name === 'apt-get') {
          const updateArgs = prefix.length ? [...prefix.slice(1), manager.name, 'update'] : ['update'];
          const update = await deps.run(command, updateArgs, Math.max(1, deadline - Date.now()));
          if (update.code === 0) result = await deps.run(command, args, Math.max(1, deadline - Date.now()));
          else result = update;
        }
        if (result.code !== 0) return `Installing bubblewrap with ${manager.name} failed: ${result.stderr}`;
      }
      return 'Installed bubblewrap automatically';
    }
    return 'No supported package manager found (apt-get/dnf/yum/apk/pacman/zypper)';
  }

  return async function prepare(command: string, args: string[], sessionDir: string): Promise<LinuxScriptSandbox> {
    const root = resolve(sessionDir);
    const diagnostics: string[] = [];
    // Do not trust presence on PATH: containers may prohibit namespaces, and
    // firejail can silently run without isolation under an existing sandbox.
    const probe = `test "$(readlink /proc/self/ns/net)" != "$1" && ! ( : > "$2/outside" ) 2>/dev/null && touch "$3/.probe" && rm "$3/.probe"`;
    const hostNetwork = deps.networkNamespace();
    const outside = mkdtempSync(join(tmpdir(), 'tokenbird-sandbox-probe-'));
    const writable = mkdtempSync(join(root, '.sandbox-probe-'));
    const candidates = [
      { backend: 'bwrap' as const, command: 'bwrap', args: [
        '--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
        '--ro-bind', '/', '/', '--bind', root, root, '--proc', '/proc', '--remount-ro', '/proc', '--dev', '/dev', '--',
      ] },
      { backend: 'bwrap' as const, command: 'bwrap', args: [
        '--die-with-parent', '--new-session', '--unshare-user', '--uid', '0', '--gid', '0',
        '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--bind', root, root,
        '--proc', '/proc', '--remount-ro', '/proc', '--dev', '/dev', '--',
      ] },
      { backend: 'firejail' as const, command: 'firejail', args: [
        '--quiet', '--noprofile', '--net=none', '--caps.drop=all', '--nonewprivs',
        '--read-only=/', `--read-write=${root}`, '--',
      ] },
    ];
    async function detect(): Promise<typeof candidates[number] | undefined> {
      for (const plan of candidates) {
        const result = await deps.run(plan.command, [...plan.args, '/bin/sh', '-c', probe,
          'sandbox-probe', hostNetwork, outside, writable], 5000);
        if (result.code === 0) return plan;
        diagnostics.push(`${plan.backend}: ${result.stderr || 'isolation verification failed'}`);
      }
      return undefined;
    }
    try {
      let plan = await detect();
      let repaired = false;
      if (!plan) {
        if (!provisioning && Date.now() - lastProvisionedAt > 60_000) {
          provisioning = installBubblewrap().then(result => {
            provisioningResult = result;
            lastProvisionedAt = Date.now();
            return result;
          }).finally(() => { provisioning = undefined; });
        }
        diagnostics.push(provisioning ? await provisioning : provisioningResult);
        plan = await detect();
        repaired = !!plan;
      }
      if (!plan) throw new Error(`Could not create Linux script sandbox after automatic repair. ${diagnostics.join('\n')}\nThe host must allow mount/network namespaces (including user namespaces for unprivileged execution).`);
      return { backend: plan.backend, command: plan.command, args: [...plan.args, command, ...args], repaired };
    } finally {
      rmSync(writable, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  };
}

export const prepareLinuxScriptSandbox = createLinuxSandboxManager();
