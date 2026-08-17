// ssh2 uses cpu-features only as an optional performance hint and catches errors.
// Throwing here selects ssh2's portable JavaScript implementation.
module.exports = function cpuFeaturesUnavailable() {
  throw new Error('cpu-features native acceleration is not bundled')
}
