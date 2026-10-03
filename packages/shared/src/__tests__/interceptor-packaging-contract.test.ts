import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor packaging contract', () => {
  it('includes interceptor-request-utils.ts in all packaging manifests/scripts', () => {
    const builderYml = readRepoFile('apps/electron/electron-builder.yml');
    const dmgScript = readRepoFile('apps/electron/scripts/build-dmg.sh');
    const linuxScript = readRepoFile('apps/electron/scripts/build-linux.sh');
    const winScript = readRepoFile('apps/electron/scripts/build-win.ps1');
    const commonBuild = readRepoFile('scripts/build/common.ts');

    expect(builderYml).toContain('packages/shared/src/interceptor-request-utils.ts');
    expect(dmgScript).toContain('interceptor-request-utils.ts');
    expect(linuxScript).toContain('interceptor-request-utils.ts');
    expect(winScript).toContain('interceptor-request-utils.ts');
    expect(builderYml).toContain('packages/shared/src/network-diagnostics.ts');
    expect(dmgScript).toContain('network-diagnostics.ts');
    expect(linuxScript).toContain('network-diagnostics.ts');
    expect(winScript).toContain('network-diagnostics.ts');
    expect(commonBuild).toContain("copyFileSync(join(sourceDir, 'network-diagnostics.ts'), join(destDir, 'network-diagnostics.ts'))");
  });
});
