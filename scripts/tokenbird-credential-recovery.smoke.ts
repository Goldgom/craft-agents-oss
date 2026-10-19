/** Real Electron recovery regression. Uses only an isolated synthetic vault.
 * Run after electron:build:main: bun scripts/tokenbird-credential-recovery.smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const electron = (await import('electron')).default as unknown as string;
for (const choice of ['picker', 'reconfigure'] as const) {
  const root = mkdtempSync(join(tmpdir(), 'tokenbird-credential-recovery-'));
  const config = join(root, 'config');
  mkdirSync(config); mkdirSync(join(root, 'electron'));
  writeFileSync(join(config, 'preferences.json'), JSON.stringify({ startupServerLocation: 'local' }));
  // Valid native framing with a synthetic, unreadable wrapped key. No real keys.
  const original = Buffer.alloc(100, 0x42);
  original.write('TBVAULT2'); original.writeUInt32LE(32, 8);
  writeFileSync(join(config, 'credentials.enc'), original);
  const report = join(root, 'result.json');
  const wrapper = join(root, 'main.cjs');
  writeFileSync(wrapper, `
const { app, BrowserWindow, dialog, safeStorage } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
app.setPath('appData', ${JSON.stringify(join(root, 'electron'))});
BrowserWindow.prototype.show = function() {};
BrowserWindow.prototype.showInactive = function() {};
let prompts = 0;
const finish = (result, code) => { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(result)); app.exit(code); };
dialog.showMessageBox = async options => {
  prompts++;
  if (!options.title.includes('Credential recovery')) throw new Error('Unexpected dialog');
  const index = options.buttons.findIndex(label => label.includes(${JSON.stringify(choice === 'picker' ? 'Choose another server' : 'Back up and reconfigure')}));
  if (index < 0) throw new Error('Recovery action missing');
  return { response: index, checkboxChecked: false };
};
dialog.showErrorBox = () => finish({ error: 'Unexpected fatal dialog' }, 1);
dialog.showMessageBoxSync = () => { finish({ error: 'Unexpected startup failure' }, 1); return 0; };
app.on('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', async () => {
    try {
      const config = ${JSON.stringify(config)};
      const active = fs.readFileSync(path.join(config, 'credentials.enc'));
      const backups = fs.readdirSync(config).filter(name => name.includes('.recovery-'));
      let credentialCount;
      if (${JSON.stringify(choice)} === 'reconfigure') {
        const length = active.readUInt32LE(8), offset = 12 + length;
        const key = Buffer.from(safeStorage.decryptString(active.subarray(12, offset)), 'base64');
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, active.subarray(offset, offset + 12));
        cipher.setAAD(active.subarray(0, offset)); cipher.setAuthTag(active.subarray(offset + 12, offset + 28));
        const store = JSON.parse(Buffer.concat([cipher.update(active.subarray(offset + 28)), cipher.final()]).toString());
        key.fill(0); credentialCount = Object.keys(store.credentials).length;
      }
      finish({ prompts, windowLoaded: true, credentialCount, backups: backups.length,
        originalPreserved: ${JSON.stringify(choice)} === 'picker'
          ? active.equals(Buffer.from(${JSON.stringify(original.toString('base64'))}, 'base64'))
          : backups.length === 1 && fs.readFileSync(path.join(config, backups[0])).equals(Buffer.from(${JSON.stringify(original.toString('base64'))}, 'base64')),
      }, 0);
    } catch (error) { finish({ error: error.message }, 1); }
  });
});
setTimeout(() => finish({ error: 'Startup recovery timed out' }, 1), 30000);
require(${JSON.stringify(resolve('apps/electron/dist/main.cjs'))});
`);
  const env = { ...process.env, TOKENBIRD_CONFIG_DIR: config };
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('TOKENBIRD_SERVER_')
      || ['TOKENBIRD_HEADLESS', 'TOKENBIRD_WORKSPACE_ID', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key];
  }
  const child = Bun.spawn([electron, wrapper], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, `Recovery ${choice} failed: ${stdout}\n${stderr}`);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(result.prompts, 1);
  assert.equal(result.windowLoaded, true);
  assert.equal(result.originalPreserved, true);
  assert.equal(result.backups, choice === 'picker' ? 0 : 1);
  if (choice === 'reconfigure') assert.equal(result.credentialCount, 0);
  console.log(`PASS real Electron ${choice}: recovery window loads and encrypted original is preserved`);
}
