/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";
import {
  copyPiAgentServer,
  copySessionServer,
  verifyMcpServersExist,
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
};

// electron-build-main compiles these into packages/*/dist. Assemble them into
// Electron resources before copying the resource tree into dist/ for packaging.
copySessionServer(buildConfig);
copyPiAgentServer(buildConfig);
verifyMcpServersExist(buildConfig);

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}
