#!/usr/bin/env bun
/** Build every supported distribution and collect the results under dist/. */

import { existsSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
// Each invocation gets fresh headless output. Old staging files can be held open
// by Windows antivirus or Explorer, so a new build must not depend on deleting them.
const runId = `${Date.now()}-${process.pid}`;
const stagingRelative = `.build-all/runs/${runId}`;
const staging = join(root, stagingRelative);
const allTargets = ['win', 'linux', 'android', 'linux-headless', 'win-headless', 'mac-headless'] as const;
type Target = typeof allTargets[number];

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: bun run build:all [targets...] [--release] [--checksums-only] [--force-download]');
  console.log(`Targets: ${allTargets.join(', ')}`);
  process.exit(0);
}
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-')) as Target[];
const targets = requested.length ? requested : [...allTargets];
const release = args.has('--release');
const forceDownload = args.has('--force-download');

for (const target of targets) {
  if (!allTargets.includes(target)) throw new Error(`Unknown target "${target}". Valid targets: ${allTargets.join(', ')}`);
}

function run(command: string, commandArgs: string[], cwd = root): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    console.log(`\n>>> ${command} ${commandArgs.join(' ')}`);
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Command exited with code ${code}`)));
  });
}

function commandAvailable(command: string): boolean {
  if (process.platform === 'win32') {
    return spawnSync('where.exe', [command], { stdio: 'ignore' }).status === 0;
  }
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function unavailableReason(target: Target): string | undefined {
  if (target === 'win' && process.platform !== 'win32') return 'Windows Electron packaging requires a Windows host';
  if (target === 'linux' && process.platform !== 'linux') return 'Linux Electron packaging requires a Linux host';
  if (target === 'android' && !commandAvailable(process.platform === 'win32' ? 'powershell.exe' : 'pwsh')) {
    return 'Android build requires PowerShell (powershell.exe or pwsh)';
  }
  return undefined;
}

function collectRelease(target: string): void {
  const source = join(root, 'apps', 'electron', 'release');
  const destination = join(dist, target);
  mkdirSync(destination, { recursive: true });
  if (!existsSync(source)) throw new Error(`Electron release directory not found: ${source}`);
  for (const file of readdirSync(source)) {
    if (!/\.(exe|msi|AppImage|dmg|zip|yml|blockmap)$/i.test(file)) continue;
    cpSync(join(source, file), join(destination, file), { recursive: true });
  }
}

async function buildDesktop(target: 'win' | 'linux'): Promise<void> {
  if (target === 'win') {
    if (process.platform !== 'win32') throw new Error('The Windows Electron package must be built on Windows.');
    await run('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', 'apps/electron/scripts/build-win.ps1', ...(forceDownload ? ['-ForceDownload'] : [])]);
  } else {
    if (process.platform !== 'linux') {
      throw new Error('The Linux Electron package must be built on Linux. Run this target in a Linux CI job or WSL.');
    }
    await run('bash', ['apps/electron/scripts/build-linux.sh', process.arch === 'arm64' ? 'arm64' : 'x64', ...(forceDownload ? ['--force-download'] : [])]);
  }
  const unpackedResources = join(root, 'apps', 'electron', 'release', target === 'win' ? 'win-unpacked' : 'linux-unpacked', 'resources');
  for (const worker of ['messaging-whatsapp-worker', 'messaging-qqbot-worker']) {
    const workerPath = join(unpackedResources, worker, 'worker.cjs');
    if (!existsSync(workerPath)) throw new Error(`Packaged worker missing: ${workerPath}`);
  }
  collectRelease(target);
}

async function writeChecksums(): Promise<void> {
  const artifacts: string[] = [];
  for (const target of allTargets) {
    const directory = join(dist, target);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (file.isFile() && /\.(?:exe|msi|AppImage|dmg|zip|apk|tar\.gz)$/i.test(file.name)) {
        artifacts.push(`${target}/${file.name}`);
      }
    }
  }
  const lines: string[] = [];
  for (const artifact of artifacts.sort()) {
    const hash = createHash('sha256');
    const stream = createReadStream(join(dist, artifact));
    for await (const chunk of stream) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${artifact}`);
  }
  writeFileSync(join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
}

function removeTargetOutput(target: Target): void {
  const destination = resolve(dist, target);
  const relativeToDist = relative(dist, destination);
  if (!relativeToDist || relativeToDist.startsWith('..') || isAbsolute(relativeToDist)) {
    throw new Error(`Refusing to remove output outside dist: ${destination}`);
  }
  rmSync(destination, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
}

async function buildHeadless(target: 'linux-headless' | 'win-headless' | 'mac-headless'): Promise<void> {
  const platform = target === 'win-headless' ? 'win32' : target === 'mac-headless' ? 'darwin' : 'linux';
  const output = join(staging, target);
  // build-server resolves --output relative to the repository root. Passing an
  // absolute Windows path would make it concatenate root + absolute path.
  const relativeOutput = `${stagingRelative}/${target}`;
  await run('bun', ['run', 'scripts/build-server.ts', `--platform=${platform}`, '--arch=x64', `--output=${relativeOutput}`, '--compress', ...(forceDownload ? ['--force-download'] : [])]);
  const destination = join(dist, target);
  mkdirSync(destination, { recursive: true });
  // Use a fresh unpacked path for every run. Even copying over an existing tree
  // can fail when Windows holds a single dependency file open.
  const unpacked = `server-${runId}`;
  cpSync(output, join(destination, unpacked), { recursive: true, dereference: true });
  const archive = readdirSync(staging).find((file) => file.startsWith(`tokenbird-server-`) && file.includes(`-${platform}-x64`) && file.endsWith('.tar.gz'));
  if (!archive) throw new Error(`Server archive missing for ${target}`);
  const collectedArchive = `${runId}-${archive}`;
  cpSync(join(staging, archive), join(destination, collectedArchive));
  writeFileSync(join(destination, 'latest.json'), JSON.stringify({ archive: collectedArchive, unpacked }, null, 2) + '\n');
}

async function main(): Promise<void> {
  // Keep other targets intact. Full builds also skip targets unsupported on this
  // host, so deleting all of dist would erase artifacts built elsewhere.
  mkdirSync(dist, { recursive: true });

  const built: Target[] = [];
  const skipped: Array<{ target: Target; reason: string }> = [];
  for (const target of targets) {
    const reason = unavailableReason(target);
    if (reason) {
      console.log(`\n--- Skipping ${target}: ${reason} ---`);
      skipped.push({ target, reason });
      continue;
    }
    if (!target.endsWith('-headless')) removeTargetOutput(target);
    if (target === 'win' || target === 'linux') await buildDesktop(target);
    else if (target === 'android') {
      const androidArgs = ['-ExecutionPolicy', 'Bypass', '-File', 'apps/android/build.ps1'];
      if (release) androidArgs.push('-Release');
      await run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', androidArgs);
      if (!existsSync(join(dist, 'android'))) throw new Error('Android build completed without dist/android output');
    } else await buildHeadless(target);
    built.push(target);
  }
  await writeChecksums();
  console.log(`\nBuilds completed. Built: ${built.length ? built.join(', ') : 'none'}`);
  if (skipped.length) console.log(`Skipped: ${skipped.map(({ target }) => target).join(', ')}`);
  console.log(`Artifacts: ${dist}`);
}

const task = args.has('--checksums-only') ? writeChecksums() : main();
task.catch((error) => { console.error(`\nBuild-all failed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
