/**
 * Cross-platform resources copy script
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { join } from "path";
import { syncResourceDirectory } from './build/resource-sync';
import { installWindowsAgentFramework } from './build/agent-framework';
import { downloadFfmpeg } from './build/ffmpeg';
import {
  copyPiAgentServer,
  copySessionServer,
  verifyMcpServersExist,
  downloadGitBash,
  downloadWindowsToolchains,
  downloadUv,
  type Arch,
  type BuildConfig,
  type Platform,
} from "./build/common";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

function currentPlatform(): Platform {
  if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") {
    return process.platform;
  }
  throw new Error(`Unsupported Electron build platform: ${process.platform}`);
}

function currentArch(): Arch {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`Unsupported Electron build architecture: ${process.arch}`);
}

const buildConfig: BuildConfig = {
  platform: currentPlatform(),
  arch: currentArch(),
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir: ROOT_DIR,
  electronDir: ELECTRON_DIR,
  forceDownload: process.env.TOKENBIRD_FORCE_DOWNLOAD === '1',
};

async function stageCodex(): Promise<void> {
  const platform = buildConfig.platform;
  const arch = process.env.TOKENBIRD_CODEX_TARGET_ARCH || buildConfig.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported Codex architecture: ${arch}`);
  const packageRoot = join(ROOT_DIR, 'node_modules', '@openai');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'codex', 'package.json'), 'utf8'));
  const platformPackage = `codex-${platform}-${arch}`;
  let source = join(packageRoot, platformPackage);
  let temporary: string | undefined;
  try {
    if (!existsSync(source)) {
      temporary = mkdtempSync(join(tmpdir(), 'tokenbird-codex-build-'));
      const tarball = await $`npm pack @openai/codex@${manifest.version}-${platform}-${arch} --pack-destination ${temporary}`.quiet().text();
      await $`tar -xf ${join(temporary, tarball.trim())} -C ${temporary}`.quiet();
      source = join(temporary, 'package');
    }
    const vendor = join(source, 'vendor');
    const binary = platform === 'win32' ? 'codex.exe' : 'codex';
    const target = readdirSync(vendor).find(name => existsSync(join(vendor, name, 'bin', binary)));
    if (!target) throw new Error(`The ${platform}/${arch} Codex package does not contain ${binary}`);
    const staging = join(ELECTRON_DIR, 'vendor', 'codex');
    const destination = join(staging, `${platform}-${arch}`);
    mkdirSync(staging, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    cpSync(join(vendor, target), destination, { recursive: true, dereference: true });
    // The npm platform archives can omit the Apache license text.
    if (!existsSync(join(source, 'LICENSE'))) cpSync(join(ROOT_DIR, 'LICENSE'), join(destination, 'LICENSE'));
    for (const notice of ['LICENSE', 'NOTICE']) {
      if (existsSync(join(source, notice))) cpSync(join(source, notice), join(destination, notice));
    }
    console.log(`Staged Codex CLI ${manifest.version} (${platform}/${arch})`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // electron-build-main compiles these into packages/*/dist. Assemble them into
  // Electron resources before copying the resource tree into dist/ for packaging.
  copySessionServer(buildConfig);
  copyPiAgentServer(buildConfig);
  verifyMcpServersExist(buildConfig);

  // Document tools rely on uv. Provision the platform binary during every
  // build so development and release bundles do not silently depend on PATH.
  await stageCodex();
  await downloadUv(buildConfig);
  await downloadFfmpeg(buildConfig);

  // Windows packages include an official PortableGit runtime so Bash and Git
  // work on a clean machine without a separate system installation.
  await downloadGitBash(buildConfig);
  await downloadWindowsToolchains(buildConfig);
  await installWindowsAgentFramework(buildConfig);

  if (existsSync(srcDir)) {
    syncResourceDirectory(srcDir, destDir);
    console.log("📦 Copied resources to dist");
  } else {
    console.log("⚠️ No resources directory found");
  }
}

main().catch((error) => {
  console.error("❌ Resource build failed:", error);
  process.exit(1);
});
