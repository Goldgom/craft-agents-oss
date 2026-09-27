/** Create a portable server archive with executable Unix entrypoints. */

import * as tar from 'tar';
import type { Platform } from './common';

function needsExecute(path: string): boolean {
  const name = path.replace(/^\.\//, '').replaceAll('\\', '/');
  return name === 'start.sh'
    || name === 'install.sh'
    || name === 'vendor/bun/bun'
    || name.startsWith('bin/')
    || name.startsWith('resources/bin/')
    || /^node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+\/claude$/.test(name)
    || name === 'node_modules/@vscode/ripgrep/bin/rg';
}

export async function createServerArchive(outputDir: string, archivePath: string, platform: Platform): Promise<void> {
  await tar.c({
    cwd: outputDir,
    file: archivePath,
    gzip: true,
    portable: true,
    onWriteEntry(entry) {
      if (platform !== 'win32' && entry.stat && needsExecute(entry.path)) {
        entry.stat.mode = 0o755;
      }
    },
  }, ['.']);
}
