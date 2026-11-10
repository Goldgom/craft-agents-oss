'use strict'
const { readFileSync } = require('node:fs')

// Validate that the MSI preserves the full interactive NSIS dependency wizard.
module.exports = async function prepareMsi(projectFile) {
  const source = readFileSync(projectFile, 'utf8')
  if (!source.includes('Id="WrappedExe"') || !source.includes('Impersonate="yes"')) {
    throw new Error('Win7 MSI must wrap the interactive NSIS installer as the current user')
  }
  if (!source.includes('ExeCommand=""')) {
    throw new Error('Win7 MSI must not silently skip the optional dependency wizard')
  }
}
