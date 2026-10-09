const { createBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder')

// useZip needs differentialPackage:false, which also disables the builder's
// installer blockmap. Generate the sidecar separately so existing updater and
// release tooling retain differential downloads, hashes and file sizes.
module.exports = async function windowsInstallerBlockmap(event) {
  if (event.target?.name !== 'nsis' || !event.file.endsWith('.exe') || event.updateInfo) return
  const nsis = event.packager.config.nsis
  if (!nsis?.useZip || nsis.differentialPackage !== false) return

  event.updateInfo = await createBlockmap(event.file, event.target, event.packager, event.safeArtifactName)
}
