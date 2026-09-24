const { existsSync, realpathSync, rmSync } = require('node:fs')
const { join, sep } = require('node:path')

module.exports = async function pruneFastWindowsResources(context) {
  if (context.electronPlatformName !== 'win32') return

  const appRoot = realpathSync(context.appOutDir)
  const duplicateBin = join(appRoot, 'resources', 'app', 'dist', 'resources', 'bin')
  if (!existsSync(duplicateBin)) return

  const resolvedBin = realpathSync(duplicateBin)
  if (!resolvedBin.startsWith(appRoot + sep)) {
    throw new Error(`Refusing to remove resources outside ${appRoot}`)
  }

  // The app resolves CLI wrappers and uv from resources/app/resources/bin.
  // dist/resources/bin is a second copy made by the cross-platform asset step.
  rmSync(resolvedBin, { recursive: true, force: true })
  console.log('Removed duplicate dist/resources/bin from fast Windows installer')
}
