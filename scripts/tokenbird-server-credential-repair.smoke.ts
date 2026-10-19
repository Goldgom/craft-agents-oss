/** Real picker -> repair form -> protected save -> server selection regression.
 * Run after electron:build:main and electron:build:renderer. Uses dummy data only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tokenbird-server-repair-'))
const config = join(root, 'config')
mkdirSync(config); mkdirSync(join(root, 'electron'))
writeFileSync(join(config, 'preferences.json'), JSON.stringify({ startupServerLocation: 'none', uiLanguage: 'en' }))
writeFileSync(join(config, 'remote-servers.json'), JSON.stringify([{
  id: 'fixture', name: 'Fixture Repair Server', url: 'wss://example.invalid', token: '', tokenRef: 'lost-token',
  createdAt: 1, updatedAt: 1,
  sftp: { enabled: true, host: 'example.invalid', port: 22, username: 'dummy', authMethod: 'password', passwordRef: 'lost-password' },
}]))
const report = join(root, 'result.json')
const wrapper = join(root, 'main.cjs')
const fillInputs = `(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [id, value] of [['repair-server-token', 'dummy-repaired-token'], ['repair-sftp-password', ' dummy-ssh-password ']]) {
    const input = document.getElementById(id); setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`
writeFileSync(wrapper, `
const { app, BrowserWindow, dialog, safeStorage, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const originalExit = app.exit.bind(app);
let restarts = 0;
let saves = 0;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
  if (channel === '__remote-servers:save') saves++;
  return handler(...args);
});
app.exit = () => { restarts++; };
app.relaunch = () => {};
app.setPath('appData', ${JSON.stringify(join(root, 'electron'))});
BrowserWindow.prototype.show = function() {};
BrowserWindow.prototype.showInactive = function() {};
const finish = (value, code) => { fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(value)); originalExit(code); };
dialog.showErrorBox = () => finish({ error: 'Unexpected fatal dialog' }, 1);
dialog.showMessageBoxSync = () => { finish({ error: 'Unexpected startup failure' }, 1); return 0; };
app.on('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', async () => {
    try {
      const run = code => contents.executeJavaScript(code);
      const wait = async code => {
        const deadline = Date.now() + 10000;
        while (!(await run(code))) { if (Date.now() > deadline) throw new Error('Timed out waiting for repair UI'); await new Promise(resolve => setTimeout(resolve, 50)); }
      };
      const blocked = await run('window.electronAPI.selectStartupServer("fixture")');
      if (blocked.success || !blocked.needsCredentialRepair || restarts) throw new Error('Unusable profile was not rejected safely');
      await wait('[...document.querySelectorAll("button")].some(button => button.textContent.includes("Fixture Repair Server"))');
      await run('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Fixture Repair Server")).click()');
      await wait('!!document.querySelector("#repair-server-token")');
      await run(${JSON.stringify(fillInputs)});
      await wait('!document.querySelector("[role=dialog] button[type=submit]").disabled');
      await run('document.querySelector("[role=dialog] form").requestSubmit()');
      await wait('!document.querySelector("#repair-server-token")');
      if (!saves) throw new Error('Repair form closed without saving');
      const config = ${JSON.stringify(config)};
      const profilesText = fs.readFileSync(path.join(config, 'remote-servers.json'), 'utf8');
      const profile = JSON.parse(profilesText)[0];
      if (profilesText.includes('dummy-repaired-token') || profilesText.includes('dummy-ssh-password')) throw new Error('Credentials were stored in plaintext');
      if (profile.id !== 'fixture' || profile.tokenRef === 'lost-token' || profile.sftp.passwordRef === 'lost-password') throw new Error('Profile references were not repaired');
      const active = fs.readFileSync(path.join(config, 'credentials.enc'));
      const length = active.readUInt32LE(8), offset = 12 + length;
      const key = Buffer.from(safeStorage.decryptString(active.subarray(12, offset)), 'base64');
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, active.subarray(offset, offset + 12));
      cipher.setAAD(active.subarray(0, offset)); cipher.setAuthTag(active.subarray(offset + 12, offset + 28));
      const store = JSON.parse(Buffer.concat([cipher.update(active.subarray(offset + 28)), cipher.final()]).toString()); key.fill(0);
      const values = Object.values(store.credentials).map(item => item.value);
      if (!values.includes('dummy-repaired-token') || !values.includes(' dummy-ssh-password ')) throw new Error('Protected credential contents were not preserved');
      const repaired = await run('window.electronAPI.selectStartupServer("fixture")');
      if (!repaired.success || restarts !== 1) throw new Error('Repaired server could not be selected');
      if (JSON.parse(fs.readFileSync(path.join(config, 'preferences.json'), 'utf8')).startupServerLocation !== 'fixture') throw new Error('Selected server was not persisted');
      if (process.env.TOKENBIRD_SERVER_TOKEN) throw new Error('Token leaked into relaunch environment');
      finish({ passed: true }, 0);
    } catch (error) { finish({ error: error.message }, 1); }
  });
});
setTimeout(() => finish({ error: 'Repair flow timed out' }, 1), 30000);
require(${JSON.stringify(resolve(process.env.TOKENBIRD_SMOKE_MAIN ?? 'apps/electron/dist/main.cjs'))});
`)
const env = { ...process.env, TOKENBIRD_CONFIG_DIR: config }
for (const key of Object.keys(env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('TOKENBIRD_SERVER_')
    || ['TOKENBIRD_HEADLESS', 'TOKENBIRD_WORKSPACE_ID', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key]
}
const electron = (await import('electron')).default as unknown as string
const child = Bun.spawn([electron, wrapper], { env, stdout: 'pipe', stderr: 'pipe' })
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
const result = JSON.parse(readFileSync(report, 'utf8'))
assert.equal(code, 0, JSON.stringify(result) + '\n' + stdout + '\n' + stderr)
assert.equal(result.passed, true)
console.log('PASS real Electron picker: missing credentials open repair form, protected save replaces references, and server selection succeeds')
