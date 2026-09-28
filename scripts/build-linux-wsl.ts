#!/usr/bin/env bun
/** Build the Linux desktop AppImage from Windows using the local WSL distro. */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
let distro: string | undefined;
let checkOnly = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log('Usage: bun run build:linux:wsl [--distro NAME] [--check]');
    process.exit(0);
  }
  if (arg === '--check') {
    checkOnly = true;
  } else if (arg === '--distro' && args[i + 1]) {
    distro = args[++i];
  } else {
    throw new Error(`Unknown or incomplete option: ${arg}`);
  }
}

if (process.platform !== 'win32') {
  throw new Error('This entry point runs on Windows. On Linux, use bun run build:all linux.');
}

// Send the script on stdin so CRLF in a Windows checkout cannot affect it.
// Arguments are passed separately to WSL, avoiding shell interpolation of paths.
const script = String.raw`set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

source_dir="$(wslpath -u "$1")"
check_only="$2"

if [ ! -f "$source_dir/package.json" ] || [ ! -f "$source_dir/apps/electron/scripts/build-linux.sh" ]; then
  echo "WSL cannot access the repository at: $source_dir" >&2
  exit 1
fi

if [ "$(uname -m)" != x86_64 ]; then
  echo 'Linux desktop packaging currently requires an x64 WSL distro.' >&2
  exit 1
fi

missing=0
for tool in bun node npm npx tar curl unzip sha256sum; do
  tool_path="$(command -v "$tool" || true)"
  if [ -z "$tool_path" ] || [[ "$tool_path" == /mnt/* ]]; then
    echo "Missing in WSL: $tool" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo 'Install Bun, Node.js/npm, curl and unzip inside WSL, then retry.' >&2
  exit 1
fi

if [ "$check_only" = true ]; then
  echo "WSL build prerequisites found. Source: $source_dir"
  exit 0
fi

umask 077
workspace="$(mktemp -d "$HOME/tokenbird-wsl-build.XXXXXXXX")"
trap 'rm -rf -- "$workspace"' EXIT

echo "Copying workspace into WSL: $workspace"
tar -C "$source_dir" \
  --exclude='./.git' --exclude='./node_modules' --exclude='./dist' \
  --exclude='./.build' --exclude='./.build-all' \
  --exclude='./apps/electron/node_modules' \
  --exclude='./apps/electron/vendor' --exclude='./apps/electron/release' \
  -cf - . | tar -C "$workspace" -xf -

# Windows Git checkouts may have CRLF even when invoked through bash.
sed -i 's/\r$//' "$workspace/apps/electron/scripts/build-linux.sh"
cd "$workspace"
bun install
bun pm trust @vscode/ripgrep
bun run build:all linux

artifact="$workspace/dist/linux/TokenBird-x64.AppImage"
if [ ! -f "$artifact" ]; then
  echo "Expected AppImage not found: $artifact" >&2
  exit 1
fi
mkdir -p "$source_dir/dist/linux"
cp -- "$artifact" "$source_dir/dist/linux/TokenBird-x64.AppImage"
echo "AppImage: $source_dir/dist/linux/TokenBird-x64.AppImage"
`;

const commandArgs = [
  ...(distro ? ['--distribution', distro] : []),
  '--exec', 'bash', '-l', '-s', '--', root, String(checkOnly),
];
const result = spawnSync('wsl.exe', commandArgs, {
  input: script,
  stdio: ['pipe', 'inherit', 'inherit'],
  maxBuffer: 1024 * 1024,
});
if (result.error) throw new Error(`Failed to start WSL: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);

if (!checkOnly) {
  const checksums = spawnSync('bun', ['run', 'build:all', '--checksums-only'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (checksums.error) throw checksums.error;
  if (checksums.status !== 0) process.exit(checksums.status ?? 1);
}
