import childProcess from 'child_process'
export * from 'child_process'
export function spawn(file, args, options = {}) {
  if (file === process.execPath) {
    const preload = process.env.TOKENBIRD_WIN7_PRELOAD
    options = { ...options, windowsHide: true, env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1',
      ...(preload ? { NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` } : {}) } }
  }
  return childProcess.spawn(file, args, options)
}
export default { ...childProcess, spawn }
