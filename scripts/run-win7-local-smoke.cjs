'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const electron = process.env.WIN7_ELECTRON_PATH || path.join(root, '.toolchains/electron-22.3.27/electron.exe')
const packaged = process.argv.includes('--packaged-app') ? ['--packaged-app'] : []
async function run(entry, args = [], nodeMode = false) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  if (nodeMode) env.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(electron, [path.join(root, entry), ...args], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk) })
  const deadline = setTimeout(() => child.kill(), 240000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(deadline)
  if (code !== 0) throw new Error(`${entry} exited ${code}\n${stdout.slice(-1000)}\n${stderr.slice(-12000)}`)
  return stdout
}
async function main() {
  await run('apps/win7-local/runtime-smoke.cjs', [], true)
  for (const protocol of [[], ['--anthropic']]) {
    const output = await run('apps/win7-local/smoke.cjs', ['--local-smoke-test', ...protocol, ...packaged])
    const result = JSON.parse(output.match(/\{\s*"success"\s*:[\s\S]*?\n\}/)[0])
    await run('apps/win7-local/restart-smoke.cjs', ['--local-smoke-test', '--restore-root', result.temp, '--restore-session', result.sessionId, ...packaged])
  }
  console.log('PASS Win7 local runtime, agent tools, permissions, credentials and restart smoke tests')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
