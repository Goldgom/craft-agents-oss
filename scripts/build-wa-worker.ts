/**
 * WhatsApp worker build script.
 *
 * Bundles the Baileys-backed WhatsApp subprocess into a single CJS file at
 * packages/messaging-whatsapp-worker/dist/worker.cjs.
 *
 * Baileys is bundled INTO the output (not marked external) so the packaged
 * app ships a self-contained worker — users don't have to install anything.
 * The dynamic import at runtime still works because esbuild resolves literal
 * dynamic-import strings at bundle time.
 *
 * The worker is spawned as a Node subprocess by the WhatsAppAdapter:
 *   - Electron: re-enters its embedded Node via ELECTRON_RUN_AS_NODE=1.
 *   - Headless/Bun server: spawns a system `node` binary (Bun cannot run the
 *     CJS worker because Baileys' crypto deps depend on Node's runtime).
 * That's why we emit CJS + platform=node — it must stay Node-compatible.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import * as esbuild from "esbuild";

/**
 * Resolve a short git SHA for the build, suffixed with `+dirty` when the
 * working tree has uncommitted changes. Returns `unknown` outside a git
 * checkout.
 */
function resolveGitSha(cwd: string): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd }).toString().trim();
    let dirty = false;
    try {
      const status = execSync("git status --porcelain", { cwd }).toString().trim();
      dirty = status.length > 0;
    } catch {
      // ignore — treat as clean
    }
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

const ROOT_DIR = join(import.meta.dir, "..");
const WORKER_DIR = join(ROOT_DIR, "packages/messaging-whatsapp-worker");
const SOURCE = join(WORKER_DIR, "src/worker.ts");
const DIST_DIR = join(WORKER_DIR, "dist");
const OUTPUT = join(DIST_DIR, "worker.cjs");

async function verifyJsFile(filePath: string): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) return { valid: false, error: "File does not exist" };
  const stats = statSync(filePath);
  if (stats.size === 0) return { valid: false, error: "File is empty" };

  // In-process esbuild parse (avoids bun's node shim executing the file)
  try {
    esbuild.transformSync(readFileSync(filePath, "utf8"), { loader: "js" });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE)) {
    console.error("❌ WhatsApp worker source not found at", SOURCE);
    process.exit(1);
  }

  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  const buildId = new Date().toISOString();
  const gitSha = resolveGitSha(ROOT_DIR);
  console.log(`📨 Building WhatsApp worker (bundling Baileys) — build ${buildId} (${gitSha})...`);

  try {
    await esbuild.build({
      entryPoints: [SOURCE], bundle: true, platform: "node", format: "cjs",
      target: "node20", outfile: OUTPUT,
      define: {
        __WA_WORKER_BUILD_ID__: JSON.stringify(buildId),
        __WA_WORKER_GIT_SHA__: JSON.stringify(gitSha),
      },
      external: ["electron", "link-preview-js", "qrcode-terminal", "jimp"],
      logLevel: "info",
    });
  } catch (error) {
    console.error("❌ WhatsApp worker build failed:", error);
    process.exit(1);
  }

  console.log("🔍 Verifying worker output...");
  const verification = await verifyJsFile(OUTPUT);
  if (!verification.valid) {
    console.error("❌ Worker build verification failed:", verification.error);
    process.exit(1);
  }

  const { size } = statSync(OUTPUT);
  console.log(`✅ WhatsApp worker built (${(size / 1024 / 1024).toFixed(2)} MB) → ${OUTPUT}`);
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
